/**
 * plugin-forge —— forge_plugin 工具与 /forge status 命令。
 *
 * 编排流程（每一步失败都不静默吞掉，如实报错）：
 *   1. 清理并重建 staging 目录（父会话工作区内 /.forge-staging/<name>）；
 *   2. 启动全新子代理（spawn provider，maxChildDepth=2：子代理还能再向下委托一层，
 *      同时封顶防无限递归），在 staging 开发并构建验证插件；
 *   3. 子代理 completed 后，把 staging 复制为 targetRoot/<name> 独立仓库，
 *      改写 package.json 的 deepseek-harness link 路径、补齐 .gitignore；
 *   4. 在目标目录重新 pnpm install + pnpm build 验证迁移结果；
 *   5. git init（如无）→ git add -A → 检查 diff → 有变更则用英文 Conventional
 *      Commit 提交一次（功能完成即提交，非定时；不 push/tag/release）；
 *   6. 登记进 $DSH_HOME/plugin-forge.json，供 /forge status 查询。
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型侧引入 dsh-commands，激活其 Context 增强（ctx.commands）。
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { commitStaged, ensureGitRepo, stageAll } from './git.ts'
import { copyInto, ensureGitignore, pathExists, rewriteHarnessLinks } from './migrate.ts'
import { buildChildPrompt } from './prompt.ts'
import { loadRegistry, upsertRepo, type ForgeRepoEntry } from './registry.ts'
import {
  findHarnessRoot,
  normalizePluginName,
  relativeLink,
  runCommand,
  slugFromRequirement,
  toPosix,
} from './utils.ts'

/** 插件配置（index.ts 的 z schema 与之对应；默认值见 index.ts）。 */
export interface ForgeConfig {
  /** 独立仓库所在根目录（Windows 路径或正斜杠均可）。 */
  readonly targetRoot: string
  /** staging 根目录；留空 = 父会话工作区/.forge-staging。 */
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
}

const TOOL_NAME = 'forge_plugin'

/** 子代理结果（stopReason + 全部文本）。 */
interface ChildOutcome {
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
  }
  const lines: string[] = []
  if (result.ok === true) {
    lines.push(`✅ 插件 ${result.pluginName ?? ''} 已生成。`)
    if (result.migratedTo !== undefined) lines.push(`📦 独立仓库：${result.migratedTo}`)
    if (result.commitSubject !== undefined) lines.push(`🔖 功能完成提交：${result.commitSubject}`)
    lines.push(`🛠 目标目录构建验证：${result.build ?? 'skipped'}`)
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
async function verifyBuildInTarget(target: string, config: ForgeConfig): Promise<string> {
  try {
    await runCommand('pnpm', ['install'], { cwd: target, timeoutMs: config.childTimeoutMs })
    await runCommand('pnpm', ['build'], { cwd: target, timeoutMs: config.childTimeoutMs })
    return 'passed'
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** 注册 forge_plugin 工具；返回撤销函数。 */
export function registerForgeTool(ctx: Context, config: ForgeConfig): () => void {
  return ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: '按需求生成 DSH 插件：启动一个新 Agent，在临时目录按姐妹插件仓库规范开发并构建验证插件；完成后迁移为 targetRoot 下的独立 git 仓库，并在功能完成时立即做一次英文 Conventional Commit（非定时提交）；仓库登记进 $DSH_HOME/plugin-forge.json（可用 /forge status 查询）。注意：本工具会启动子代理、需要网络（pnpm install），单次可能耗时数分钟到数十分钟。',
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
      const requirement = String(args.requirement ?? '')
      if (requirement.trim() === '') throw new Error('requirement 不能为空')
      const name = normalizePluginName(args.name, slugFromRequirement(requirement))
      const targetRoot = typeof args.targetRoot === 'string' && args.targetRoot.trim() !== ''
        ? path.resolve(args.targetRoot)
        : path.resolve(config.targetRoot)
      const migrate = args.migrate !== false
      const update = args.update === true

      // 工作区 = 父会话 cwd；staging 放在工作区内（子代理沙箱可写）。
      const sessionCwd = parent.session.header.cwd
      const workspace = sessionCwd !== undefined && sessionCwd.trim() !== ''
        ? path.resolve(sessionCwd)
        : process.cwd()
      const stagingRoot = config.stagingRoot.trim() !== ''
        ? path.resolve(config.stagingRoot)
        : path.join(workspace, '.forge-staging')
      const staging = path.join(stagingRoot, name)
      const harnessRoot = config.harnessRoot.trim() !== ''
        ? path.resolve(config.harnessRoot)
        : await findHarnessRoot(workspace)
      const target = path.join(targetRoot, name)

      // 1. 目标存在性检查（防止误覆盖）。
      const targetExists = await pathExists(target)
      if (migrate && targetExists && !update) {
        throw new Error(`目标目录已存在：${toPosix(target)}。请换一个 name，或设置 update=true 明确更新。`)
      }

      // 2. 清理并重建 staging。
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })

      // 3. 启动子代理开发。
      const provider = ctx.subagents.getProvider(config.subagentProvider)
      if (provider === undefined) {
        throw new Error(`subagent provider "${config.subagentProvider}" 未注册（base bundle 应内置 spawn）`)
      }
      const promptText = buildChildPrompt({
        requirement,
        name,
        stagingDir: staging,
        harnessRoot,
        relativeHarnessPath: relativeLink(staging, harnessRoot),
        targetRoot,
      })
      const run: SubagentRun = await ctx.subagents.start(config.subagentProvider, {
        label: `forge plugin: ${name}`,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        signal: exec.signal,
        maxDepth: config.maxChildDepth,
      })
      const child = await collectChild(run)
      if (child.stopReason !== 'completed') {
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
      if (migrate) {
        migratedTo = target
        await copyInto(staging, migratedTo)
        const packageJson = path.join(migratedTo, 'package.json')
        if (await pathExists(packageJson)) {
          await rewriteHarnessLinks(packageJson, staging, migratedTo, harnessRoot)
        }
        await ensureGitignore(migratedTo)
        build = await verifyBuildInTarget(migratedTo, config)
        if (build !== 'passed') {
          throw new Error(
            `迁移后构建验证失败：${build}\nstaging 保留在 ${toPosix(staging)}，目标目录为 ${toPosix(migratedTo)}。`
            + ' 请检查 link 路径改写或依赖；修复后可对目标目录重试 pnpm install && pnpm build。',
          )
        }
        // 功能完成 → 立即提交（非定时）；提交前 stageAll 已检查 diff。
        await ensureGitRepo(migratedTo)
        const hasChanges = await stageAll(migratedTo)
        if (hasChanges) {
          const summaryEn = report?.summaryEn?.trim() ?? ''
          commitSubject = `${config.commitType}: ${name}${summaryEn === '' ? '' : `: ${summaryEn}`}`
          await commitStaged(migratedTo, commitSubject, {
            name: config.gitAuthorName,
            email: config.gitAuthorEmail,
          })
          committed = true
        }
        const migratedPath = toPosix(migratedTo)
        const previous = (await loadRegistry()).repos.find((repo) => repo.path === migratedPath)
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
      }
    },
  }))
}

/** 注册 /forge status 命令；返回撤销函数。 */
export function registerForgeCommand(ctx: Context): () => void {
  return ctx.commands.register({
    name: 'forge',
    description: '查看 plugin-forge 已创建的插件仓库（路径 / 最近提交 / 提交次数）',
    handler: async () => {
      const registry = await loadRegistry()
      if (registry.repos.length === 0) {
        return { kind: 'success' as const, text: 'plugin-forge 尚未创建任何插件仓库。' }
      }
      const lines = registry.repos.map((repo) => {
        const when = repo.lastCommitAt === undefined
          ? '（尚无提交）'
          : new Date(repo.lastCommitAt).toLocaleString('zh-CN')
        return `- ${repo.name}（${repo.path}）\n  最近提交：${when}，共 ${repo.commitCount} 次`
      })
      return {
        kind: 'success' as const,
        text: `plugin-forge 已创建的插件仓库（${registry.repos.length} 个）：\n${lines.join('\n')}`,
      }
    },
  })
}
