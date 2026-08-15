/**
 * DSH 插件生成工具（host 半区）：forge_plugin 工具 + /forge status + 自迭代引导。
 * AI 原生：AI 自发判断缺口 → 子代理开发 → 独立仓库交付 → 自动热挂载。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  registerForgeCommand,
  registerForgeTool,
  selfIterationSectionText,
  SELF_ITERATION_SECTION_ORDER,
  type ForgeConfig,
} from './forge.ts'

export const name = 'plugin-forge'

/** 需要注入的服务：工具注册表、子代理运行时、命令注册表、系统提示词（自迭代引导）。 */
export const inject = ['tools', 'subagents', 'commands', 'systemPrompt']

/** 配置（默认值即出厂值；cordis.patch.yml 的 config 可覆盖）。 */
export interface Config extends ForgeConfig {}

/**
 * 出厂默认值（唯一真源）。
 * Config schema 的 .default() 从这里取值，避免两份默认值漂移；
 * 直接 apply()（不经 loader）时也用它兜底。
 */
export const DEFAULTS: Config = {
  targetRoot: '',
  stagingRoot: '',
  harnessRoot: '',
  subagentProvider: 'spawn',
  maxChildDepth: 2,
  childTimeoutMs: 2_700_000,
  commitType: 'feat',
  push: false,
  gitAuthorName: 'csiroqa',
  gitAuthorEmail: 'justinwangyj@163.com',
  keepStaging: true,
  // 参考仓库默认留空：机器专属路径不应作为出厂默认；
  // 未配置时 prompt.ts 会提示用 dsh-schedule/dsh-hotkeys 通用结构。
  referenceRepos: [],
  stagingTtlDays: 0,
  installProfile: '',
}

export const Config: z<Config> = z.object({
  /** 独立仓库所在根目录；留空 = 项目根（调用方工作区的父目录）/dsh-plugins。 */
  targetRoot: z.string().default(DEFAULTS.targetRoot),
  /** staging 根目录；留空 = 父会话工作区/.forge-staging。 */
  stagingRoot: z.string().default(DEFAULTS.stagingRoot),
  /** deepseek-harness 检出根；留空 = 从工作区向上自动查找。 */
  harnessRoot: z.string().default(DEFAULTS.harnessRoot),
  /** 子代理 provider 名。 */
  subagentProvider: z.string().default(DEFAULTS.subagentProvider),
  /** 子代理最大委托深度：2 = 子代理还能再向下委托一层，同时封顶防递归。 */
  maxChildDepth: z.natural().min(1).max(5).default(DEFAULTS.maxChildDepth),
  /** 子代理及目标目录构建的超时（毫秒），默认 45 分钟。 */
  childTimeoutMs: z.natural().min(60_000).default(DEFAULTS.childTimeoutMs),
  /** Conventional Commit 类型。 */
  commitType: z.string().default(DEFAULTS.commitType),
  /** 是否提交后 push（默认 false，遵守 AGENTS.md 不自动 push）。 */
  push: z.boolean().default(DEFAULTS.push),
  /** 仓库未配置 git 身份时的作者名。 */
  gitAuthorName: z.string().default(DEFAULTS.gitAuthorName),
  /** 仓库未配置 git 身份时的作者邮箱。 */
  gitAuthorEmail: z.string().default(DEFAULTS.gitAuthorEmail),
  /** 成功后是否保留 staging 目录（便于排查）。 */
  keepStaging: z.boolean().default(DEFAULTS.keepStaging),
  /** 子代理提示词中列出的参考仓库（姐妹插件，工具链/格式/风格对照）。 */
  referenceRepos: z.array(z.string()).default(DEFAULTS.referenceRepos),
  /** staging 目录保留天数；超过则在下一次 forge 调用时清理；0 = 不清理（默认）。 */
  stagingTtlDays: z.natural().default(DEFAULTS.stagingTtlDays),
  /** 迁移并提交成功后自动装入的 profile 名（如 'web'）；留空 = 不自动安装。 */
  installProfile: z.string().default(DEFAULTS.installProfile),
})

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const merged: Config = { ...DEFAULTS, ...config }
  registerForgeTool(ctx, merged)
  registerForgeCommand(ctx)
  // 自迭代引导：让 agent 在需要新能力时自发调用 forge_plugin。
  ctx.systemPrompt.section({
    name: 'self-iteration:forge_plugin',
    order: SELF_ITERATION_SECTION_ORDER,
    text: () => selfIterationSectionText(),
  })
  ctx.logger.info('plugin-forge 已加载：forge_plugin 工具与 /forge status 命令可用（targetRoot=%s）', merged.targetRoot)
}

// ---- 供 smoke/单元测试复用的纯函数导出（仅保留有脚本消费者或外部契约的符号） ----
export {
  ensureGitignore,
  copyInto,
  pathExists,
  rewriteHarnessLinks,
  rewriteCiHarnessPaths,
  syncRemoveStale,
} from './migrate.ts'
export {
  commitStaged,
  ensureGitRepo,
  stageAll,
  type GitIdentity,
} from './git.ts'
export {
  loadRegistry,
  upsertRepo,
  type ForgeRegistry,
  type ForgeRepoEntry,
} from './registry.ts'
export {
  findHarnessRoot,
  normalizePluginName,
  relativeLink,
  runCommand,
  slugFromRequirement,
  toPosix,
  assertOk,
  buildCommitSubject,
  samePath,
  type ExecResult,
} from './utils.ts'
export {
  parseChildReport,
  runForge,
  resolveTargetRoot,
  cleanupStaleStaging,
  assertNoRegistryHarnessDeps,
  verifyBuildInTarget,
  selfIterationSectionText,
  SELF_ITERATION_SECTION_ORDER,
  type ChildReport,
  type ForgeArgs,
  type ForgeLogger,
  type ForgeToolResult,
  type StartChild,
} from './forge.ts'
export { mountPlugin, type HotMountResult } from './hotmount.ts'
export { verifyPluginLoad, type VerifyLoadResult } from './verify-load.ts'
export { buildChildPrompt, type ChildPromptContext } from './prompt.ts'
