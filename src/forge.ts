/**
 * forge_plugin 工具与 /forge status 命令。
 * 流程：staging → 子代理开发 → 迁移（link/CI 改写、依赖守卫、加载冒烟）→ 提交 → 登记 → 热挂载。
 * 编排抽成 runForge()，子代理经 startChild 注入以便测试。
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型侧引入 dsh-commands，激活其 Context 增强（ctx.commands）。
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  callStatRows,
  callStatsPath,
  clearCallStats,
  formatPluginCallSummary,
  loadCallStats,
  recordToolCall,
} from './call-stats.ts'
import { commitStaged, ensureGitRepo, stageAll } from './git.ts'
import { mountPlugin } from './hotmount.ts'
import { copyChangedInto, copyInto, ensureGitignore, EXCLUDED_BASENAMES, pathExists, PNPM_STORE, rewriteCiHarnessPaths, rewriteHarnessLinks, syncRemoveStale } from './migrate.ts'
import { verifyPluginLoad } from './verify-load.ts'
import { buildChildPrompt } from './prompt.ts'
import { detectActiveProfile } from './profile.ts'
import { loadRegistry, upsertRepo, type ForgeRepoEntry } from './registry.ts'
import {
  buildCommitSubject,
  dshHome,
  findHarnessRoot,
  normalizePluginName,
  relativeLink,
  runCommand,
  samePath,
  slugFromRequirement,
  toPosix,
  truncateTail,
} from './utils.ts'

/** 插件配置（index.ts 的 z schema 与之对应；默认值见 index.ts）。 */
export interface ForgeConfig {
  /**
   * 独立仓库所在根目录；留空（默认）= 调用方工作区/dsh-plugins。
   * forge_plugin 的 targetRoot 参数可临时覆盖。
   */
  readonly targetRoot: string
  /** staging 根目录；留空 = 调用方工作区/.forge-staging。 */
  readonly stagingRoot: string
  /** deepseek-harness 检出根；留空 = 从工作区向上自动查找。 */
  readonly harnessRoot: string
  /** 子代理 provider 名（默认 spawn，base bundle 内置）。 */
  readonly subagentProvider: string
  /** 子代理最大委托深度（默认 2：可再向下委托一层，同时封顶防递归）。 */
  readonly maxChildDepth: number
  /** 子代理（及目标目录构建）超时（毫秒）。 */
  readonly childTimeoutMs: number
  /** Conventional Commit 类型（默认 feat）。 */
  readonly commitType: string
  /** 是否在提交后 push（默认 false；AGENTS.md：不自动 push）。 */
  readonly push: boolean
  /** 仓库未配置 git 身份时的作者名。 */
  readonly gitAuthorName: string
  /** 仓库未配置 git 身份时的作者邮箱。 */
  readonly gitAuthorEmail: string
  /** 成功后是否保留 staging 目录（默认 true，便于排查）。 */
  readonly keepStaging: boolean
  /** 子代理提示词中列出的参考仓库（姐妹插件，用于工具链/格式/风格对照）。 */
  readonly referenceRepos: string[]
  /** staging 目录保留天数；超过则在下一次 forge 调用时清理；0 = 不清理。 */
  readonly stagingTtlDays: number
  /** 迁移并提交成功后自动装入的 profile 名（如 'web'）；留空 = 自动探测当前 profile。 */
  readonly installProfile: string
  /**
   * 迁移并提交成功后自动装入当前 profile（默认 true）。
   * agent 不能自发重启：热挂载覆盖本会话，profile 装入覆盖重启后。
   * install: false 参数可关闭本次调用。
   */
  readonly autoInstall: boolean
}

/** 自迭代引导 section 的渲染顺序（紧随 tool-subagent 的 116.5 之后）。 */
export const SELF_ITERATION_SECTION_ORDER = 117

/** 输出文本截断长度（工具返回值/日志中携带的子代理文本尾部）。 */
const TEXT_TAIL = 500

/** 子代理未正常完成时携带的部分输出长度。 */
const CHILD_TEXT_TAIL = 1500

/** registry 中 summaryZh 的上限字符数（服务于自迭代引导节"已有插件"清单，M-R2-9）。 */
const SUMMARY_ZH_MAX = 60

/** 构建验证的状态（用于工具结果 build 字段，M-R2-6 判别联合）。 */
export type BuildStatus = 'passed' | 'skipped' | 'failed'

/** 每天毫秒数（staging TTL 清理用）。 */
const MS_PER_DAY = 86_400_000

/** 自迭代引导节（systemPrompt section，随每次提示词组装渲染）。 */
export function selfIterationSectionText(): string {
  return [
    '你是 DSH 的自迭代智能体：能力不足时用 `forge_plugin` 生成插件补齐。',
    '执行任务时若缺少所需工具、只能手工重复处理、或发现可跨会话复用的功能，应调用 `forge_plugin` 生成插件。',
    '生成后自动热挂载。重复需求使用 update=true 迭代，子代理自动检测重复。',
  ].join('\n')
}

const TOOL_NAME = 'forge_plugin'

/** plugin-forge 自身在调用账本里的插件名（与仓库目录名一致）。 */
const FORGE_PLUGIN_NAME = 'plugin-forge'

/** 进程内同名任务互斥：同一插件名同时只允许一个 forge 流程（防 staging/目标冲突）。 */
const activeForge = new Set<string>()

/** 最小日志面（execute 传入 ctx.logger；测试可不传）。 */
export interface ForgeLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** 子代理结果（stopReason + 全部文本）。 */
export interface ChildOutcome {
  readonly stopReason: SubagentResult['stopReason']
  readonly text: string
}

/** 从 REPORT 块解析出的关键字段（与 prompt.ts 的 REPORT 协议逐项对应，只保留有消费者的字段）。 */
export interface ChildReport {
  summaryZh?: string
  summaryEn?: string
  notes?: string
  /** 子代理检测到需求与已有插件重复时，填已有插件名（此时不开发）。 */
  duplicateOf?: string
  /** 重复检测说明（重叠点/差异）。 */
  duplicateNote?: string
}

/** forge_plugin 的调用参数（经 schema 校验后）。 */
export interface ForgeArgs {
  readonly requirement: string
  readonly name?: string
  readonly targetRoot?: string
  readonly migrate?: boolean
  readonly update?: boolean
  /** 装入 profile：缺省跟随 autoInstall（默认自动装入当前 profile）；false 关闭；true 强制。 */
  readonly install?: boolean
  /** 迁移并提交成功后是否热挂载到当前运行时（无需重启）。 */
  readonly hot?: boolean
}

/** runForge 的成功/失败结果（工具 output.schema 的结构化值）。 */
export interface ForgeToolResult {
  readonly ok: boolean
  readonly pluginName: string
  readonly migratedTo?: string
  readonly committed: boolean
  readonly commitSubject?: string
  /** 构建验证状态（'passed' | 'skipped' | 'failed'）。 */
  readonly build: BuildStatus
  readonly files: string[]
  readonly childReport?: string
  readonly error?: string
  /** 是否已装入 profile（重启后生效）。 */
  readonly installed?: boolean
  /** 未装入 profile 的原因（尝试过但探测失败/命令失败时）。 */
  readonly installDetail?: string
  /** 是否已热挂载到当前运行时（hot: true）。 */
  readonly hotMounted?: boolean
  /** 热挂载失败原因（hot: true 但未能挂载时）。 */
  readonly hotDetail?: string
  /** 子代理检测到重复、未新建（true 时建议用 update=true 迭代既有插件）。 */
  readonly duplicated?: boolean
  /** 重复检测命中的已有插件名。 */
  readonly existingName?: string
}

/** 子代理启动请求（runForge 注入点）。 */
export interface StartChildRequest {
  readonly label: string
  readonly promptText: string
  readonly signal: AbortSignal
  readonly maxDepth: number
}

/** 子代理启动函数：真实路径包 ctx.subagents，测试注入假实现。 */
export type StartChild = (request: StartChildRequest) => Promise<ChildOutcome>

/** 收集子代理结果并在任何路径下释放 run（与 tool-subagent 的 settle 一致）。 */
async function collectChild(run: SubagentRun): Promise<ChildOutcome> {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `子代理运行失败：${String(execution.reason)}；dispose 失败：${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  const result = execution.value
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return { stopReason: result.stopReason, text }
}

/** 解析子代理报告中的 REPORT_START/REPORT_END 块（与 prompt.ts 的协议字段对应）。 */
export function parseChildReport(text: string): ChildReport | undefined {
  const match = /REPORT_START([\s\S]*?)REPORT_END/.exec(text)
  if (match === null || match[1] === undefined) return undefined
  const report: ChildReport = {}
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (key === 'summary_zh') report.summaryZh = value
    else if (key === 'summary_en') report.summaryEn = value
    else if (key === 'notes') report.notes = value
    else if (key === 'duplicate_of') report.duplicateOf = value
    else if (key === 'duplicate_note') report.duplicateNote = value
  }
  return Object.keys(report).length > 0 ? report : undefined
}

/** 递归列出目录下所有相对文件路径（排序，正斜杠）。 */
async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDED_BASENAMES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(toPosix(path.relative(root, full)))
    }
  }
  await walk(root)
  return files.sort()
}

/** 剔除 undefined 字段：DSH 工具返回值必须是无损 JSON，undefined 属性会在往返中丢失。 */
function withoutUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) out[key] = val
  }
  return out as T
}

/** 把工具返回的 value 渲染成模型可见文本（字段集合与 ForgeToolResult 一致）。 */
function renderResult(value: JsonValue): string {
  const result = value as Partial<ForgeToolResult>
  const lines: string[] = []
  if (result.duplicated === true) {
    lines.push(`需求与已有插件「${result.existingName ?? '?'}」重复，未新建。用 update=true 迭代，或调整需求。`)
    const note = result.childReport
    if (note !== undefined && note.trim() !== '') {
      lines.push(`检测说明：${truncateTail(note.trim(), TEXT_TAIL)}`)
    }
    return lines.join('\n')
  }
  if (result.ok === true) {
    lines.push(`插件 ${result.pluginName ?? ''} 已生成。`)
    if (result.migratedTo !== undefined) lines.push(`仓库：${result.migratedTo}`)
    if (result.commitSubject !== undefined) lines.push(`提交：${result.commitSubject}`)
    lines.push(`构建验证：${result.build ?? 'skipped'}`)
    if (result.installed === true) {
      lines.push('已装入 profile，重启后生效。')
    } else if (result.installDetail !== undefined) {
      lines.push(`未装入 profile：${result.installDetail}`)
    }
    if (result.hotMounted === true) {
      lines.push('已热挂载到当前运行时。')
    } else if (result.hotDetail !== undefined) {
      lines.push(`热挂载未完成：${result.hotDetail}`)
    }
    const report = result.childReport
    if (report !== undefined && report.trim() !== '') {
      lines.push(`\n子代理汇报：\n${truncateTail(report.trim(), TEXT_TAIL)}`)
    }
  } else {
    lines.push(`插件生成失败：${result.error ?? '未知错误'}`)
    if (result.migratedTo !== undefined) lines.push(`（staging/目标目录：${result.migratedTo}）`)
  }
  return lines.join('\n')
}

/** 构建验证结果（结构化契约，与 verifyPluginLoad 的 { ok, detail } 一致，M07）。 */
export interface BuildVerifyResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 在目标目录重新安装并构建，验证迁移结果。返回 { ok, detail }；ok=false 时 detail 为失败原因。 */
export async function verifyBuildInTarget(
  target: string,
  config: ForgeConfig,
  signal?: AbortSignal,
): Promise<BuildVerifyResult> {
  try {
    await runCommand('pnpm', ['install'], { cwd: target, timeoutMs: config.childTimeoutMs, signal })
    await runCommand('pnpm', ['build'], { cwd: target, timeoutMs: config.childTimeoutMs, signal })
    // 构建"通过"不等于可安装：main/types 若已声明则必须真实存在且不逃逸包目录
    // （防子代理产出 index.mjs 却声明 main: lib/index.js、或声明写成绝对路径 / ../ 逃逸）。
    // 字段缺失视为"未声明"，不强制（合法插件可只声明 main 不声明 types——B-R2-3 收紧范围）。
    const packageJsonPath = path.join(target, 'package.json')
    if (await pathExists(packageJsonPath)) {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        main?: string
        types?: string
      }
      const invalid: string[] = []
      for (const field of ['main', 'types'] as const) {
        const value = pkg[field]
        if (value === undefined) continue
        if (typeof value !== 'string' || value.trim() === '') {
          invalid.push(`${field}=${String(value)}（非字符串）`)
          continue
        }
        const resolved = path.resolve(target, value)
        if (!(await pathExists(resolved))) {
          invalid.push(`${field}=${value}（文件不存在）`)
          continue
        }
        // 逃逸检测：解析后的入口必须位于包目录内（拒绝 `../` 或指向别处的绝对路径）。
        const rel = path.relative(target, resolved)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          invalid.push(`${field}=${value}（逃逸包目录）`)
        }
      }
      if (invalid.length > 0) {
        return { ok: false, detail: `package.json 的入口声明异常：${invalid.join('、')}（构建产物与声明不一致）` }
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 校验迁移后的 package.json 里没有写成 registry 版本号的 @deepseek-ai/* 依赖。 */
export async function assertNoRegistryHarnessDeps(packageJsonPath: string, harnessRoot: string): Promise<void> {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const violations: string[] = []
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section]
    if (deps === undefined) continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (dep.startsWith('@deepseek-ai/') && typeof spec === 'string' && !spec.startsWith('link:')) {
        violations.push(`${dep}@${spec}`)
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `发现 registry 版本形式的 @deepseek-ai/* 依赖（必须 link: 指向 ${toPosix(harnessRoot)}）：${violations.join(', ')}`,
    )
  }
}

/**
 * 清理 stagingRoot 下超过 ttlDays 天的旧 staging 目录；返回清理数量。
 * activeNames 中正在使用的插件名目录会被跳过（防止误删活跃任务）。
 */
export async function cleanupStaleStaging(
  stagingRoot: string,
  ttlDays: number,
  activeNames: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (ttlDays <= 0) return 0
  let entries
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - ttlDays * MS_PER_DAY
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PNPM_STORE) continue
    if (activeNames.has(entry.name)) continue
    const full = path.join(stagingRoot, entry.name)
    try {
      const meta = await stat(full)
      if (meta.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      // 单个目录清理失败不影响其余。
    }
  }
  return removed
}

/** 迁移目标根：显式参数 > 配置 > 默认（工作区父目录/dsh-plugins，与工作区平级）。 */
export function resolveTargetRoot(args: ForgeArgs, config: ForgeConfig, workspace: string): string {
  if (args.targetRoot !== undefined && args.targetRoot.trim() !== '') {
    return path.resolve(args.targetRoot)
  }
  if (config.targetRoot.trim() !== '') {
    return path.resolve(config.targetRoot)
  }
  return path.join(path.dirname(workspace), 'dsh-plugins')
}

/** runForge 的输入（workspace 与 harnessRoot 由调用方解析，便于测试注入）。 */
export interface RunForgeOptions {
  readonly config: ForgeConfig
  /** 调用方工作区（子代理沙箱可写范围，staging 位于其下）。 */
  readonly workspace: string
  readonly harnessRoot: string
  readonly args: ForgeArgs
  readonly signal: AbortSignal
  readonly startChild: StartChild
  /** 可选日志面（真实路径传 ctx.logger）。 */
  readonly logger?: ForgeLogger
}

/**
 * 互斥释放守卫（B-R2-2）：若子代理在取消/超时时不能使 runForgeLocked 收敛，
 * 该 promise 保证 signal 触发后必然 settle，从而 runForge 的 finally 一定执行，
 * 同名插件名不会被永久标记为"进行中"。
 */
function abortSettle(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error(message))
      return
    }
    signal.addEventListener('abort', () => reject(new Error(message)), { once: true })
  })
}

/** forge 全流程编排（可测试核心）；关键失败 throw；同名任务进程内互斥。 */
export async function runForge(options: RunForgeOptions): Promise<ForgeToolResult> {
  const requirement = String(options.args.requirement ?? '')
  if (requirement.trim() === '') throw new Error('requirement 不能为空')
  const name = normalizePluginName(options.args.name, slugFromRequirement(requirement))
  if (activeForge.has(name)) {
    throw new Error(`同名 forge 任务进行中（${name}）：请等待其完成后再试。`)
  }
  activeForge.add(name)
  try {
    const locked = runForgeLocked(options, name)
    // 竞速：正常完成走 locked；signal 触发走 abortSettle，确保 finally 释放互斥。
    // 落败的一方被 catch 吞掉，避免后台孤儿 promise 产生 unhandled rejection。
    const raced = Promise.race([locked, abortSettle(options.signal, `forge 任务被取消（${name}）`)])
    raced.catch(() => locked.catch(() => undefined))
    return await raced
  } finally {
    activeForge.delete(name)
  }
}

/** 准备 staging：清理重建；update 模式预填充目标现有源码（子代理增量修改）。 */
async function prepareStaging(staging: string, target: string, mode: 'create' | 'update'): Promise<void> {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  if (mode === 'update') {
    await copyInto(target, staging)
  }
}

/** runForge 的持锁主体（name 已归一化且互斥已获取）。 */
async function runForgeLocked(options: RunForgeOptions, name: string): Promise<ForgeToolResult> {
  const { config, workspace, harnessRoot, args, signal, startChild, logger } = options
  const requirement = String(args.requirement ?? '')
  const targetRoot = resolveTargetRoot(args, config, workspace)
  const migrate = args.migrate !== false
  const update = args.update === true

  const stagingRoot = config.stagingRoot.trim() !== ''
    ? path.resolve(config.stagingRoot)
    : path.join(workspace, '.forge-staging')
  const staging = path.join(stagingRoot, name)
  const target = path.join(targetRoot, name)

  // 0. 顺带清理过期的旧 staging（配置开启时；跳过当前活跃的 name）。
  await cleanupStaleStaging(stagingRoot, config.stagingTtlDays, activeForge)

  // 1. 目标存在性检查（防止误覆盖）。
  const targetExists = await pathExists(target)
  if (migrate && targetExists && !update) {
    throw new Error(`目标目录已存在：${toPosix(target)}。请换一个 name，或设置 update=true 明确更新。`)
  }
  const mode: 'create' | 'update' = update && targetExists ? 'update' : 'create'
  logger?.info('forge_plugin: 开始%s插件 %s（staging=%s）', mode === 'update' ? '更新' : '生成', name, toPosix(staging))

  // 2. 准备 staging（清理重建；update 模式预填充现有源码，子代理只需增量修改）。
  await prepareStaging(staging, target, mode)

  // 3. 启动子代理开发。
  const promptText = buildChildPrompt({
    requirement,
    name,
    mode,
    stagingDir: staging,
    harnessRoot,
    relativeHarnessPath: relativeLink(staging, harnessRoot),
    targetRoot,
    referenceRepos: config.referenceRepos,
  })
  const child = await startChild({
    label: `forge plugin: ${name}`,
    promptText,
    signal,
    maxDepth: config.maxChildDepth,
  })
  logger?.info('forge_plugin: 子代理完成 %s（%s）', name, child.stopReason)
  if (child.stopReason !== 'completed') {
    logger?.warn('forge_plugin: 子代理未正常完成 %s（%s）', name, child.stopReason)
    throw new Error(
      `子代理未正常完成（${child.stopReason}）。staging 保留在 ${toPosix(staging)}。`
      + (child.text.trim() === '' ? '' : `\n部分输出：\n${truncateTail(child.text.trim(), CHILD_TEXT_TAIL)}`),
    )
  }
  const report = parseChildReport(child.text)

  // 3.5 重复检测：子代理发现需求与已有插件重复时，拒绝新建。
  if (report?.duplicateOf !== undefined && report.duplicateOf.trim() !== '') {
    logger?.info('forge_plugin: 检测到与已有插件重复 %s → %s，未新建', name, report.duplicateOf.trim())
    return withoutUndefined({
      ok: true,
      pluginName: name,
      committed: false,
      build: 'skipped',
      files: [],
      duplicated: true,
      existingName: report.duplicateOf.trim(),
      childReport: truncateTail(report.duplicateNote ?? '', TEXT_TAIL),
    })
  }

  // 4. 文件清单。
  const files = await listRelativeFiles(staging)
  if (files.length === 0) {
    throw new Error(`子代理未在 staging 产出任何文件：${toPosix(staging)}`)
  }

  // 5. 迁移 + 目标验证 + 提交（独立函数，便于单独测试）。
  let migratedTo: string | undefined
  let committed = false
  let commitSubject: string | undefined
  // 工具结果用字符串概括构建验证（'passed' / 'skipped' / 'failed'）；详见 MigrateOutcome.build。
  let build: BuildStatus = 'skipped'
  let installed = false
  let installDetail: string | undefined
  if (migrate) {
    const outcome = await migrateAndCommit({
      config,
      name,
      staging,
      target,
      harnessRoot,
      mode,
      args,
      signal,
      report,
      logger,
    })
    migratedTo = outcome.migratedTo
    committed = outcome.committed
    commitSubject = outcome.commitSubject
    build = outcome.build.ok ? 'passed' : 'failed'
    installed = outcome.installed
    installDetail = outcome.installDetail
  }

  // 6. 收尾：保留 staging（默认）供排查。
  if (!config.keepStaging) {
    await rm(staging, { recursive: true, force: true })
  }

  return withoutUndefined({
    ok: true,
    pluginName: name,
    migratedTo: migratedTo === undefined ? undefined : toPosix(migratedTo),
    committed,
    commitSubject,
    build,
    files,
    childReport: report === undefined ? truncateTail(child.text, TEXT_TAIL) : truncateTail(report.notes ?? '', TEXT_TAIL),
    installed,
    installDetail,
  })
}

/** migrateAndCommit 的结果。 */
export interface MigrateOutcome {
  readonly migratedTo: string
  readonly committed: boolean
  readonly commitSubject?: string
  /** 构建验证结果（ok=true 表示通过）。 */
  readonly build: BuildVerifyResult
  readonly installed: boolean
  readonly installDetail?: string
}

/** migrateAndCommit 的输入。 */
interface MigrateOptions {
  readonly config: ForgeConfig
  readonly name: string
  readonly staging: string
  readonly target: string
  readonly harnessRoot: string
  readonly mode: 'create' | 'update'
  readonly args: ForgeArgs
  readonly signal: AbortSignal
  readonly report: ChildReport | undefined
  readonly logger?: ForgeLogger
}

/**
 * 迁移 + 目标验证 + 提交 + 登记 + push + profile 安装。
 * 从 runForgeLocked 拆出：任一关键失败 throw（staging 保留供排查）。
 */
export async function migrateAndCommit(options: MigrateOptions): Promise<MigrateOutcome> {
  const { config, name, staging, target, harnessRoot, mode, args, signal, report, logger } = options
  const migratedTo = target

  // B3 守卫：目标存在性检查在子代理启动前做过，但子代理开发期间（可能数十分钟）
  // 目标目录可能被其他进程创建/改写——复制前重新检查，防静默覆盖。
  if (mode === 'create' && (await pathExists(target))) {
    throw new Error(
      `目标目录在子代理开发期间被创建：${toPosix(target)}。请换一个 name，或设置 update=true 明确更新。`,
    )
  }

  // update 模式：差异回写（只拷 staging 相对 target 变化的内容，P02），
  // 再同步删除 target 中 staging 已不存在的源文件（防残留）。
  if (mode === 'update') {
    await copyChangedInto(staging, migratedTo)
    await syncRemoveStale(staging, migratedTo)
  } else {
    await copyInto(staging, migratedTo)
  }
  const packageJson = path.join(migratedTo, 'package.json')
  if (await pathExists(packageJson)) {
    await rewriteHarnessLinks(packageJson, migratedTo, harnessRoot)
    await assertNoRegistryHarnessDeps(packageJson, harnessRoot)
  }
  // CI 里的 deepseek-harness 相对路径也要从 staging 深度对齐到目标深度。
  await rewriteCiHarnessPaths(
    path.join(migratedTo, '.github', 'workflows', 'ci.yml'),
    migratedTo,
    harnessRoot,
  )
  await ensureGitignore(migratedTo)
  const build = await verifyBuildInTarget(migratedTo, config, signal)
  if (!build.ok) {
    logger?.warn('forge_plugin: 迁移后构建验证失败 %s：%s', name, build.detail ?? '')
    throw new Error(
      `迁移后构建验证失败：${build.detail ?? '未知原因'}\nstaging 保留在 ${toPosix(staging)}，目标目录为 ${toPosix(migratedTo)}。`
      + ' 请检查 link 路径改写或依赖；修复后可对目标目录重试 pnpm install && pnpm build，'
      + ' 重试 forge 时请带 update=true（目标目录已存在）。',
    )
  }
  // 加载冒烟：构建通过不等于能加载——apply 期错误（如命令 input.hint 为空）
  // 会让 DSH 重启时整个插件树崩溃（真实事故：session-notes）。此处拦截。
  const load = await verifyPluginLoad(migratedTo)
  if (!load.ok) {
    logger?.warn('forge_plugin: 加载冒烟未通过 %s：%s', name, load.detail ?? '')
    throw new Error(
      `加载冒烟未通过，已阻止交付：${load.detail ?? ''}`
      + `\n请修复 apply 期错误后重试（staging 保留在 ${toPosix(staging)}，目标目录为 ${toPosix(migratedTo)}，重试带 update=true）。`,
    )
  }
  // 功能完成 → 立即提交（非定时）；提交前 stageAll 已检查 diff。
  await ensureGitRepo(migratedTo)
  const hasChanges = await stageAll(migratedTo)
  let commitSubject: string | undefined
  let committed = false
  if (hasChanges) {
    commitSubject = buildCommitSubject(config.commitType, name, report?.summaryEn)
    await commitStaged(migratedTo, commitSubject, {
      name: config.gitAuthorName,
      email: config.gitAuthorEmail,
    })
    committed = true
    logger?.info('forge_plugin: 已提交 %s：%s', toPosix(migratedTo), commitSubject)
  }
  const migratedPath = toPosix(migratedTo)
  const previous = (await loadRegistry()).repos.find((repo) => samePath(repo.path, migratedPath))
  const entry: ForgeRepoEntry = {
    name,
    path: migratedPath,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    lastCommitAt: committed ? new Date().toISOString() : previous?.lastCommitAt,
    commitCount: (previous?.commitCount ?? 0) + (committed ? 1 : 0),
    summaryZh: report?.summaryZh?.slice(0, SUMMARY_ZH_MAX) ?? previous?.summaryZh,
  }
  await upsertRepo(entry)
  // push 默认关闭（AGENTS.md：不自动 push）；仅在配置显式开启时执行。
  if (committed && config.push) {
    await runCommand('git', ['push'], { cwd: migratedTo, timeoutMs: config.childTimeoutMs, signal })
  }
  // 自迭代流程：默认自动装入当前 profile。agent 不能自发重启，
  // 热挂载覆盖本会话、profile 装入覆盖重启后；install: false 可关闭，
  // installProfile 显式指定时优先于自动探测。
  let installed = false
  let installDetail: string | undefined
  if (shouldInstall(args, config)) {
    const profile = config.installProfile.trim() !== ''
      ? config.installProfile.trim()
      : await detectActiveProfile(path.join(dshHome(), 'profiles'))
    if (profile === undefined) {
      installDetail = '未探测到当前 profile（bundles 不含 @deepseek-ai/dsh-web-app）。可配置 installProfile 显式指定。'
      logger?.warn('forge_plugin: 未探测到当前 profile，跳过装入 %s', name)
    } else {
      const install = await runCommand(
        'dsh',
        ['plugin', '--profile', profile, 'add', `link:${migratedPath}`],
        { cwd: migratedTo, timeoutMs: config.childTimeoutMs, signal },
      )
      if (install.code !== 0) {
        installDetail = truncateTail(install.stderr.trim(), TEXT_TAIL)
        logger?.warn('forge_plugin: 装入 profile 失败 %s：%s', name, install.stderr.trim())
      } else {
        installed = true
        logger?.info('forge_plugin: 已装入 profile %s：%s', profile, migratedPath)
      }
    }
  }
  return { migratedTo, committed, commitSubject, build, installed, installDetail }
}

/** install 参数三态 → 是否尝试装入 profile：缺省跟随配置 autoInstall。 */
export function shouldInstall(args: ForgeArgs, config: ForgeConfig): boolean {
  return args.install === true || (args.install === undefined && config.autoInstall)
}

/** 注册 forge_plugin 工具；返回撤销函数。 */
/** 工具输出 JSON-schema 的 properties（M03：单一维护源；satisfies 约束与 ForgeToolResult 字段对齐）。 */
const RESULT_SCHEMA_PROPERTIES = {
  ok: { type: 'boolean', required: true },
  pluginName: { type: 'string', required: true },
  migratedTo: { type: 'string' },
  committed: { type: 'boolean', required: true },
  commitSubject: { type: 'string' },
  build: { type: 'string', required: true },
  files: { type: 'array', items: { type: 'string' }, required: true },
  childReport: { type: 'string' },
  error: { type: 'string' },
  installed: { type: 'boolean' },
  installDetail: { type: 'string' },
  hotMounted: { type: 'boolean' },
  hotDetail: { type: 'string' },
  duplicated: { type: 'boolean' },
  existingName: { type: 'string' },
} as const satisfies Record<Exclude<keyof ForgeToolResult, 'ok' | 'pluginName' | 'committed' | 'build' | 'files'> | 'ok' | 'pluginName' | 'committed' | 'build' | 'files', unknown>

export function registerForgeTool(ctx: Context, config: ForgeConfig): () => void {
  return ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: '按需生成 DSH 插件：子代理开发构建，迁移为「项目根/dsh-plugins/<name>」独立 git 仓库，功能完成即提交（英文 Conventional Commit），自动热挂载（本会话立即可用，agent 不能自发重启），缺省自动装入当前 profile（重启后生效；install:false 关闭），登记（/forge status 可查）。每个插件的工具调用次数汇入统一账本（/forge stats 可查）。子代理自动检测重复，已存在则返回 existingName，改用 update=true 迭代。耗时数分钟、需网络。',
    parameters: {
      requirement: {
        type: 'string',
        required: true,
        description: '插件需求（中文优先，尽量具体完整）。',
      },
      name: {
        type: 'string',
        description: '插件/仓库目录名（kebab-case）；缺省自动生成。',
      },
      targetRoot: {
        type: 'string',
        description: '迁移根目录；缺省项目根/dsh-plugins。',
      },
      migrate: {
        type: 'boolean',
        description: '是否迁移为独立仓库并提交（默认 true）。',
      },
      update: {
        type: 'boolean',
        description: '更新既有仓库（默认 false）。',
      },
      install: {
        type: 'boolean',
        description: '装入 profile（缺省自动装入当前 profile；false 关闭；installProfile 配置可显式指定）。',
      },
      hot: {
        type: 'boolean',
        description: '热挂载到当前运行时（默认 true；false 关闭）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: RESULT_SCHEMA_PROPERTIES,
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    // 会写 staging/目标目录与 git，禁止与其他调用并发。
    isConcurrencySafe: () => false,
    timeoutMs: config.childTimeoutMs,
    async execute(args, exec) {
      // 自身也记账：/forge stats 能看到 forge_plugin 被调用了多少次。
      // 记账是旁路：finally 里吞掉异常，绝不影响 forge 流程。
      let callOk = false
      let callDetail: string | undefined
      try {
        const parent = exec.agent
        if (parent === undefined) {
          throw new Error(`${TOOL_NAME} 需要调用方 agent（exec.agent 缺失）`)
        }
        // 工作区 = 父会话 cwd；staging 放在工作区内（子代理沙箱可写）。
        const sessionCwd = parent.session.header.cwd
        const workspace = sessionCwd !== undefined && sessionCwd.trim() !== ''
          ? path.resolve(sessionCwd)
          : process.cwd()
        const harnessRoot = config.harnessRoot.trim() !== ''
          ? path.resolve(config.harnessRoot)
          : await findHarnessRoot(workspace)

        const startChild: StartChild = async (request) => {
          const provider = ctx.subagents.getProvider(config.subagentProvider)
          if (provider === undefined) {
            throw new Error(`subagent provider "${config.subagentProvider}" 未注册（base bundle 应内置 spawn）`)
          }
          const run: SubagentRun = await ctx.subagents.start(config.subagentProvider, {
            label: request.label,
            prompt: [{ type: 'text', text: request.promptText }],
            parent,
            signal: request.signal,
            maxDepth: request.maxDepth,
          })
          return collectChild(run)
        }

        const result = await runForge({
          config,
          workspace,
          harnessRoot,
          args,
          signal: exec.signal,
          startChild,
          logger: ctx.logger,
        })
        // 热挂载（默认开启）：生成成功后挂载到当前运行时（无需重启）。
        // 热挂载失败不阻塞交付（已提交的仓库始终可用），仅返回 hotDetail 提示。
        if (args.hot !== false && result.ok && result.migratedTo !== undefined) {
          const mount = await mountPlugin(ctx, result.migratedTo)
          if (mount.ok) {
            ctx.logger.info('forge_plugin: 已热挂载 %s 到当前运行时', result.migratedTo)
            callOk = true
            return withoutUndefined({ ...result, hotMounted: true })
          }
          ctx.logger.warn('forge_plugin: 热挂载失败 %s：%s', result.migratedTo, mount.detail ?? '')
          callDetail = mount.detail
          return withoutUndefined({ ...result, hotMounted: false, hotDetail: mount.detail })
        }
        callOk = result.ok
        return result
      } catch (error) {
        callDetail = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        recordToolCall(FORGE_PLUGIN_NAME, TOOL_NAME, callOk ? 'ok' : 'failed', callDetail)
      }
    },
  }))
}

/** /forge 的子命令：status（默认）/ stats [插件名] / stats reset [插件名]。 */
export type ForgeSubcommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'stats'; readonly plugin?: string; readonly reset: boolean }

/** 解析 /forge 后的输入；空输入与无法识别的输入都按 status 处理（保持旧的裸 /forge 行为）。 */
export function parseForgeSubcommand(rawInput: string): ForgeSubcommand {
  const tokens = rawInput.trim().split(/\s+/u).filter((token) => token !== '')
  if (tokens.length === 0 || tokens[0] === 'status') return { kind: 'status' }
  if (tokens[0] !== 'stats') return { kind: 'status' }
  if (tokens[1] === 'reset') {
    return tokens[2] === undefined
      ? { kind: 'stats', reset: true }
      : { kind: 'stats', plugin: tokens[2], reset: true }
  }
  return tokens[1] === undefined
    ? { kind: 'stats', reset: false }
    : { kind: 'stats', plugin: tokens[1], reset: false }
}

/** /forge status：仓库清单 + 每个插件的工具调用摘要。 */
async function forgeStatusText(): Promise<string> {
  const registry = await loadRegistry()
  if (registry.repos.length === 0) {
    return 'plugin-forge 尚未创建任何插件仓库。'
  }
  const stats = await loadCallStats()
  const lines: string[] = []
  for (const repo of registry.repos) {
    const exists = await pathExists(repo.path)
    const when = repo.lastCommitAt === undefined
      ? '（尚无提交）'
      : new Date(repo.lastCommitAt).toLocaleString('zh-CN')
    let head = '无 HEAD'
    let cleanliness = '—'
    if (exists) {
      const log = await runCommand('git', ['log', '-1', '--format=%h %s'], { cwd: repo.path })
      if (log.code === 0 && log.stdout.trim() !== '') head = log.stdout.trim()
      const status = await runCommand('git', ['status', '--porcelain'], { cwd: repo.path })
      cleanliness = status.code === 0 && status.stdout.trim() === '' ? '干净' : '有未提交改动'
    }
    lines.push(
      `- ${repo.name}（${repo.path}）\n  HEAD：${head}；工作区：${exists ? cleanliness : '目录不存在'}；`
      + `最近提交：${when}，累计 ${repo.commitCount} 次；`
      + formatPluginCallSummary(stats, repo.name),
    )
  }
  return `plugin-forge 已创建的插件仓库（${registry.repos.length} 个）：\n${lines.join('\n')}`
}

/** /forge stats [插件名]：按插件/工具列调用次数；stats reset 清零账本。 */
async function forgeStatsText(sub: Extract<ForgeSubcommand, { kind: 'stats' }>): Promise<string> {
  if (sub.reset) {
    const removed = await clearCallStats(sub.plugin)
    return sub.plugin === undefined
      ? '已清空全部插件的调用次数记录。'
      : `已清空 ${sub.plugin} 的调用次数记录（${removed} 个工具）。`
  }
  const stats = await loadCallStats()
  const rows = callStatRows(stats, sub.plugin)
  if (rows.length === 0) {
    return sub.plugin === undefined
      ? `尚无任何插件的工具调用记录（账本：${callStatsPath()}）。`
      : `${sub.plugin} 尚无工具调用记录（账本：${callStatsPath()}）。`
  }
  const header = '| 插件 | 工具 | 调用 | 成功 | 失败 | 最近调用 |\n| --- | --- | ---: | ---: | ---: | --- |'
  return [
    `工具调用次数（${sub.plugin ?? '全部插件'}）：`,
    header,
    ...rows,
    '',
    `账本：${callStatsPath()}`,
  ].join('\n')
}

/** 注册 /forge 命令（status / stats 子命令）；返回撤销函数。 */
export function registerForgeCommand(ctx: Context): () => void {
  return ctx.commands.register({
    name: 'forge',
    description: '查看 plugin-forge 已创建的插件仓库（路径 / HEAD / 工作区状态 / 最近提交 / 工具调用次数）；/forge stats 看调用明细',
    input: { hint: 'status | stats [插件名] | stats reset [插件名]' },
    handler: async (invocation) => {
      const sub = parseForgeSubcommand(invocation.rawInput)
      const text = sub.kind === 'stats' ? await forgeStatsText(sub) : await forgeStatusText()
      return { kind: 'success' as const, text }
    },
  })
}
