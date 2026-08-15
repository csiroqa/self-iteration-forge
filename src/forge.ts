/**
 * plugin-forge —— forge_plugin 工具与 /forge status 命令。
 *
 * 编排流程（每一步失败都不静默吞掉，如实报错）：
 *   1. （可选）清理 stagingRoot 下过期的旧 staging 目录；
 *   2. 清理并重建本次 staging 目录（调用方工作区内 /.forge-staging/<name>）；
 *   3. 启动全新子代理（spawn provider，maxChildDepth=2：子代理还能再向下委托
 *      一层，同时封顶防无限递归），在 staging 开发并构建验证插件；
 *   4. 子代理 completed 后，把 staging 复制为 targetRoot/<name> 独立仓库：
 *      改写 deepseek-harness link 路径、补齐 .gitignore、校验没有写成
 *      registry 版本号的 @deepseek-ai/* 依赖；
 *   5. 在目标目录重新 pnpm install + pnpm build 验证迁移结果；
 *   6. git init（如无）→ git add -A → 检查 diff → 有变更则用英文 Conventional
 *      Commit 提交一次（功能完成即提交，非定时；不 push/tag/release）；
 *   7. 登记进 $DSH_HOME/plugin-forge.json，供 /forge status 查询。
 *
 * 核心编排抽成 runForge()，子代理启动通过 startChild 注入——单元/集成测试
 * 可以注入假子代理，完整跑通「staging → 迁移 → 构建验证 → 提交 → 登记」。
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
import { commitStaged, ensureGitRepo, stageAll } from './git.ts'
import { mountPlugin } from './hotmount.ts'
import { copyInto, ensureGitignore, pathExists, rewriteCiHarnessPaths, rewriteHarnessLinks, syncRemoveStale } from './migrate.ts'
import { buildChildPrompt } from './prompt.ts'
import { loadRegistry, upsertRepo, type ForgeRepoEntry } from './registry.ts'
import {
  buildCommitSubject,
  findHarnessRoot,
  normalizePluginName,
  relativeLink,
  runCommand,
  samePath,
  slugFromRequirement,
  toPosix,
} from './utils.ts'

/** 插件配置（index.ts 的 z schema 与之对应；默认值见 index.ts）。 */
export interface ForgeConfig {
  /** 独立仓库所在根目录（Windows 路径或正斜杠均可）。 */
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
  /** 迁移并提交成功后自动装入的 profile 名（如 'web'）；留空 = 不自动安装。 */
  readonly installProfile: string
}

/** 自迭代引导 section 的渲染顺序（紧随 tool-subagent 的 116.5 之后）。 */
export const SELF_ITERATION_SECTION_ORDER = 117

/**
 * 面向 agent 的自迭代策略（systemPrompt section，随每次提示词组装渲染）。
 * 让 agent 在需要新能力时**自发**调用 forge_plugin，而不是等用户明确要求。
 */
export function selfIterationSectionText(): string {
  return [
    '你是 DSH 的自迭代智能体：`forge_plugin` 工具允许你按需生成/更新 DSH 插件来扩展自身能力。',
    '**在正常描述需求的工作中自发发现并调用**（无需用户明确说"做插件"）：',
    '1. 当前功能值得作为插件固化（重复出现、跨会话复用、可独立成小工具）；',
    '2. 需要使用当前没有的能力（工具集/命令集缺口）；',
    '3. 作为单个插件不会太重（保持小而专一；太重就拆成多个）。',
    '调用策略：一次迭代一个清晰的小功能（不要一次生成多个）；需求不清晰时先做合理假设并在结果中说明。',
    '交付后**无缝切换**：传 `hot: true` 立即热挂载到当前运行时（无需重启，当前会话马上可用）；',
    '如需重启后也生效，再传 `install: true` 装入 profile（需配置 installProfile）。',
    '本工具会启动子代理、需要网络、耗时数分钟，调用期间可继续其他工作；完成后可用 `/forge status` 查询已建仓库。',
  ].join('')
}

const TOOL_NAME = 'forge_plugin'

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

/** 从 REPORT 块解析出的关键字段。 */
export interface ChildReport {
  summaryZh?: string
  summaryEn?: string
  build?: string
  typecheck?: string
  test?: string
  files?: string
  notes?: string
}

/** forge_plugin 的调用参数（经 schema 校验后）。 */
export interface ForgeArgs {
  readonly requirement: string
  readonly name?: string
  readonly targetRoot?: string
  readonly migrate?: boolean
  readonly update?: boolean
  /** 迁移并提交成功后是否自动装入 profile（需配置 installProfile）。 */
  readonly install?: boolean
  /** 迁移并提交成功后是否热挂载到当前运行时（无缝切换，无需重启）。 */
  readonly hot?: boolean
}

/** runForge 的成功/失败结果（工具 output.schema 的结构化值）。 */
export interface ForgeToolResult {
  readonly ok: boolean
  readonly pluginName: string
  readonly migratedTo?: string
  readonly committed: boolean
  readonly commitSubject?: string
  readonly build: string
  readonly files: string[]
  readonly childReport?: string
  readonly error?: string
  /** 是否已自动装入 profile（install: true 且配置了 installProfile）。 */
  readonly installed?: boolean
  /** 是否已热挂载到当前运行时（hot: true）。 */
  readonly hotMounted?: boolean
  /** 热挂载失败原因（hot: true 但未能挂载时）。 */
  readonly hotDetail?: string
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

/** 解析子代理报告中的 REPORT_START/REPORT_END 块。 */
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
    else if (key === 'build') report.build = value
    else if (key === 'typecheck') report.typecheck = value
    else if (key === 'test') report.test = value
    else if (key === 'files') report.files = value
    else if (key === 'notes') report.notes = value
  }
  return Object.keys(report).length > 0 ? report : undefined
}

/** 递归列出目录下所有相对文件路径（排序，正斜杠）。 */
async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.pnpm-store') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(toPosix(path.relative(root, full)))
    }
  }
  await walk(root)
  return files.sort()
}

/** 把工具返回的 value 渲染成模型可见文本。 */
function renderResult(value: JsonValue): string {
  const result = value as {
    ok?: boolean
    pluginName?: string
    migratedTo?: string
    committed?: boolean
    commitSubject?: string
    build?: string
    childReport?: string
    error?: string
    installed?: boolean
    hotMounted?: boolean
    hotDetail?: string
  }
  const lines: string[] = []
  if (result.ok === true) {
    lines.push(`✅ 插件 ${result.pluginName ?? ''} 已生成。`)
    if (result.migratedTo !== undefined) lines.push(`📦 独立仓库：${result.migratedTo}`)
    if (result.commitSubject !== undefined) lines.push(`🔖 功能完成提交：${result.commitSubject}`)
    lines.push(`🛠 目标目录构建验证：${result.build ?? 'skipped'}`)
    if (result.installed === true) lines.push('⚙️ 已自动装入 profile，重启后立即可用。')
    if (result.hotMounted === true) {
      lines.push('⚡ 已热挂载到当前运行时：无需重启，本会话立即可以使用新能力。')
    } else if (result.hotDetail !== undefined) {
      lines.push(`⚠️ 热挂载未完成：${result.hotDetail}`)
    }
    const report = result.childReport
    if (report !== undefined && report.trim() !== '') {
      lines.push(`\n子代理汇报：\n${report.trim().slice(0, 4000)}`)
    }
  } else {
    lines.push(`❌ 插件生成失败：${result.error ?? '未知错误'}`)
    if (result.migratedTo !== undefined) lines.push(`（staging/目标目录：${result.migratedTo}）`)
  }
  return lines.join('\n')
}

/** 在目标目录重新安装并构建，验证迁移结果；返回 'passed' 或失败原因。 */
export async function verifyBuildInTarget(target: string, config: ForgeConfig): Promise<string> {
  try {
    await runCommand('pnpm', ['install'], { cwd: target, timeoutMs: config.childTimeoutMs })
    await runCommand('pnpm', ['build'], { cwd: target, timeoutMs: config.childTimeoutMs })
    // 构建"通过"不等于可安装：main/types 指向的文件必须真实存在
    // （防子代理产出 index.mjs 却声明 main: lib/index.js 之类）。
    const packageJsonPath = path.join(target, 'package.json')
    if (await pathExists(packageJsonPath)) {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        main?: string
        types?: string
      }
      const missing: string[] = []
      for (const field of ['main', 'types'] as const) {
        const value = pkg[field]
        if (value !== undefined && typeof value === 'string') {
          const resolved = path.resolve(target, value)
          if (!(await pathExists(resolved))) missing.push(`${field}=${value}`)
        }
      }
      if (missing.length > 0) {
        return `failed: package.json 声明的 ${missing.join('、')} 不存在（构建产物与声明不一致）`
      }
    }
    return 'passed'
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`
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

/** 清理 stagingRoot 下超过 ttlDays 天的旧 staging 目录；返回清理数量。 */
export async function cleanupStaleStaging(stagingRoot: string, ttlDays: number): Promise<number> {
  if (ttlDays <= 0) return 0
  let entries
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - ttlDays * 86_400_000
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.pnpm-store') continue
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
 * forge 全流程编排（可测试核心）：
 * staging → 子代理开发 → 迁移 → 依赖守卫 → 目标构建验证 → 提交 → 登记。
 * 关键失败直接 throw（由工具注册表转为 isError 结果）。
 * 同名任务进程内互斥（并发调用直接拒绝，不排队）。
 */
export async function runForge(options: RunForgeOptions): Promise<ForgeToolResult> {
  const requirement = String(options.args.requirement ?? '')
  if (requirement.trim() === '') throw new Error('requirement 不能为空')
  const name = normalizePluginName(options.args.name, slugFromRequirement(requirement))
  if (activeForge.has(name)) {
    throw new Error(`同名 forge 任务进行中（${name}）：请等待其完成后再试。`)
  }
  activeForge.add(name)
  try {
    return await runForgeLocked(options, name)
  } finally {
    activeForge.delete(name)
  }
}

/** runForge 的持锁主体（name 已归一化且互斥已获取）。 */
async function runForgeLocked(options: RunForgeOptions, name: string): Promise<ForgeToolResult> {
  const { config, workspace, harnessRoot, args, signal, startChild, logger } = options
  const requirement = String(args.requirement ?? '')
  const targetRoot = args.targetRoot !== undefined && args.targetRoot.trim() !== ''
    ? path.resolve(args.targetRoot)
    : path.resolve(config.targetRoot)
  const migrate = args.migrate !== false
  const update = args.update === true

  const stagingRoot = config.stagingRoot.trim() !== ''
    ? path.resolve(config.stagingRoot)
    : path.join(workspace, '.forge-staging')
  const staging = path.join(stagingRoot, name)
  const target = path.join(targetRoot, name)

  // 0. 顺带清理过期的旧 staging（配置开启时）。
  await cleanupStaleStaging(stagingRoot, config.stagingTtlDays)

  // 1. 目标存在性检查（防止误覆盖）。
  const targetExists = await pathExists(target)
  if (migrate && targetExists && !update) {
    throw new Error(`目标目录已存在：${toPosix(target)}。请换一个 name，或设置 update=true 明确更新。`)
  }
  const mode: 'create' | 'update' = update && targetExists ? 'update' : 'create'
  logger?.info('forge_plugin: 开始%s插件 %s（staging=%s）', mode === 'update' ? '更新' : '生成', name, toPosix(staging))

  // 2. 清理并重建 staging。
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // 更新模式：预填充现有源码，子代理只需增量修改（省去重读重写全部文件）。
  if (mode === 'update') {
    await copyInto(target, staging)
  }

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
      + (child.text.trim() === '' ? '' : `\n部分输出：\n${child.text.slice(0, 4000)}`),
    )
  }
  const report = parseChildReport(child.text)

  // 4. 文件清单。
  const files = await listRelativeFiles(staging)
  if (files.length === 0) {
    throw new Error(`子代理未在 staging 产出任何文件：${toPosix(staging)}`)
  }

  // 5. 迁移 + 目标验证 + 提交。
  let migratedTo: string | undefined
  let committed = false
  let commitSubject: string | undefined
  let build = 'skipped'
  let installed = false
  if (migrate) {
    migratedTo = target
    await copyInto(staging, migratedTo)
    // 更新模式：同步删除目标中 staging 已不存在的源文件（防残留）。
    if (mode === 'update') {
      await syncRemoveStale(staging, migratedTo)
    }
    const packageJson = path.join(migratedTo, 'package.json')
    if (await pathExists(packageJson)) {
      await rewriteHarnessLinks(packageJson, staging, migratedTo, harnessRoot)
      await assertNoRegistryHarnessDeps(packageJson, harnessRoot)
    }
    // CI 里的 deepseek-harness 相对路径也要从 staging 深度对齐到目标深度。
    await rewriteCiHarnessPaths(
      path.join(migratedTo, '.github', 'workflows', 'ci.yml'),
      migratedTo,
      harnessRoot,
    )
    await ensureGitignore(migratedTo)
    build = await verifyBuildInTarget(migratedTo, config)
    if (build !== 'passed') {
      logger?.warn('forge_plugin: 迁移后构建验证失败 %s：%s', name, build)
      throw new Error(
        `迁移后构建验证失败：${build}\nstaging 保留在 ${toPosix(staging)}，目标目录为 ${toPosix(migratedTo)}。`
        + ' 请检查 link 路径改写或依赖；修复后可对目标目录重试 pnpm install && pnpm build，'
        + ' 重试 forge 时请带 update=true（目标目录已存在）。',
      )
    }
    // 功能完成 → 立即提交（非定时）；提交前 stageAll 已检查 diff。
    await ensureGitRepo(migratedTo)
    const hasChanges = await stageAll(migratedTo)
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
    }
    await upsertRepo(entry)
    // push 默认关闭（AGENTS.md：不自动 push）；仅在配置显式开启时执行。
    if (committed && config.push) {
      await runCommand('git', ['push'], { cwd: migratedTo, timeoutMs: config.childTimeoutMs })
    }
    // 自迭代闭环：install: true 且配置了 installProfile 时，装入 profile 立即可用。
    // 默认关闭（不擅自修改用户 profile 配置）。
    if (args.install === true && config.installProfile.trim() !== '') {
      const install = await runCommand(
        'dsh',
        ['plugin', '--profile', config.installProfile.trim(), 'add', `link:${migratedPath}`],
        { cwd: migratedTo, timeoutMs: config.childTimeoutMs },
      )
      if (install.code !== 0) {
        logger?.warn('forge_plugin: 装入 profile 失败 %s：%s', name, install.stderr.trim())
      } else {
        installed = true
        logger?.info('forge_plugin: 已装入 profile %s：%s', config.installProfile.trim(), migratedPath)
      }
    }
  }

  // 6. 收尾：保留 staging（默认）供排查。
  if (!config.keepStaging) {
    await rm(staging, { recursive: true, force: true })
  }

  return {
    ok: true,
    pluginName: name,
    migratedTo: migratedTo === undefined ? undefined : toPosix(migratedTo),
    committed,
    commitSubject,
    build,
    files,
    childReport: report === undefined ? child.text.slice(0, 2000) : report.notes ?? '',
    installed,
  }
}

/** 注册 forge_plugin 工具；返回撤销函数。 */
export function registerForgeTool(ctx: Context, config: ForgeConfig): () => void {
  return ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: '按需求生成 DSH 插件，用于 agent 自迭代：在正常工作中发现功能值得固化、或需要当前没有的能力、且作为单个插件不会太重时，可自发调用本工具（无需用户明确要求"做插件"）。流程：启动一个新 Agent，在临时目录按姐妹插件仓库规范开发并构建验证插件；完成后迁移为 targetRoot 下的独立 git 仓库，并在功能完成时立即做一次英文 Conventional Commit（非定时提交）；仓库登记进 $DSH_HOME/plugin-forge.json（可用 /forge status 查询）。无缝切换：传 hot: true 立即热挂载到当前运行时（无需重启，本会话马上可用）；传 install: true 自动装入 profile（需配置 installProfile）。注意：本工具会启动子代理、需要网络（pnpm install），单次可能耗时数分钟到数十分钟。',
    parameters: {
      requirement: {
        type: 'string',
        required: true,
        description: '插件需求（中文优先）：功能、行为、交互、配置等，尽量具体完整。',
      },
      name: {
        type: 'string',
        description: '插件/仓库目录名（kebab-case，小写字母数字连字符）。缺省时从需求自动生成。',
      },
      targetRoot: {
        type: 'string',
        description: '独立仓库所在根目录；缺省使用插件配置的 targetRoot（默认 D:/2-OGP）。',
      },
      migrate: {
        type: 'boolean',
        description: '是否迁移为独立 git 仓库并提交（默认 true；false 时只开发不落地）。',
      },
      update: {
        type: 'boolean',
        description: '目标目录已存在时是否允许更新（默认 false：已存在则报错，避免误覆盖）。',
      },
      install: {
        type: 'boolean',
        description: '迁移并提交成功后是否自动装入 profile 立即可用（默认 false；需配置 installProfile，重启后生效）。',
      },
      hot: {
        type: 'boolean',
        description: '迁移并提交成功后是否热挂载到当前运行时（默认 false；true = 无缝切换，当前会话立即获得新工具/命令，无需重启）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
          hotMounted: { type: 'boolean' },
          hotDetail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    // 会写 staging/目标目录与 git，禁止与其他调用并发。
    isConcurrencySafe: () => false,
    timeoutMs: config.childTimeoutMs,
    async execute(args, exec) {
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
      // 无缝切换：hot: true 时把新插件热挂载到当前运行时（无需重启）。
      if (args.hot === true && result.ok && result.migratedTo !== undefined) {
        const mount = await mountPlugin(ctx, result.migratedTo)
        if (mount.ok) {
          ctx.logger.info('forge_plugin: 已热挂载 %s 到当前运行时', result.migratedTo)
          return { ...result, hotMounted: true }
        }
        ctx.logger.warn('forge_plugin: 热挂载失败 %s：%s', result.migratedTo, mount.detail ?? '')
        return { ...result, hotMounted: false, hotDetail: mount.detail }
      }
      return result
    },
  }))
}

/** 注册 /forge status 命令；返回撤销函数。 */
export function registerForgeCommand(ctx: Context): () => void {
  return ctx.commands.register({
    name: 'forge',
    description: '查看 plugin-forge 已创建的插件仓库（路径 / HEAD / 工作区状态 / 最近提交）',
    handler: async () => {
      const registry = await loadRegistry()
      if (registry.repos.length === 0) {
        return { kind: 'success' as const, text: 'plugin-forge 尚未创建任何插件仓库。' }
      }
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
          + `最近提交：${when}，累计 ${repo.commitCount} 次`,
        )
      }
      return {
        kind: 'success' as const,
        text: `plugin-forge 已创建的插件仓库（${registry.repos.length} 个）：\n${lines.join('\n')}`,
      }
    },
  })
}
