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

/** Config schema 的默认值（唯一真源；apply 经 Config() 求值，保证直接 apply 路径也生效）。 */
const CONFIG_DEFAULTS: Config = {
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
  // 默认自动装入当前 profile：agent 不能自发重启，热挂载覆盖本会话、
  // profile 装入覆盖重启后；install: false 参数可关闭单次调用。
  autoInstall: true,
}

export const Config: z<Config> = z.object({
  /** 独立仓库所在根目录；留空 = 项目根（调用方工作区的父目录）/dsh-plugins。 */
  targetRoot: z.string().default(CONFIG_DEFAULTS.targetRoot),
  /** staging 根目录；留空 = 父会话工作区/.forge-staging。 */
  stagingRoot: z.string().default(CONFIG_DEFAULTS.stagingRoot),
  /** deepseek-harness 检出根；留空 = 从工作区向上自动查找。 */
  harnessRoot: z.string().default(CONFIG_DEFAULTS.harnessRoot),
  /** 子代理 provider 名。 */
  subagentProvider: z.string().default(CONFIG_DEFAULTS.subagentProvider),
  /** 子代理最大委托深度：2 = 子代理还能再向下委托一层，同时封顶防递归。 */
  maxChildDepth: z.natural().min(1).max(5).default(CONFIG_DEFAULTS.maxChildDepth),
  /** 子代理及目标目录构建的超时（毫秒），默认 45 分钟。 */
  childTimeoutMs: z.natural().min(60_000).default(CONFIG_DEFAULTS.childTimeoutMs),
  /** Conventional Commit 类型。 */
  commitType: z.string().default(CONFIG_DEFAULTS.commitType),
  /** 是否提交后 push（默认 false，遵守 AGENTS.md 不自动 push）。 */
  push: z.boolean().default(CONFIG_DEFAULTS.push),
  /** 仓库未配置 git 身份时的作者名。 */
  gitAuthorName: z.string().default(CONFIG_DEFAULTS.gitAuthorName),
  /** 仓库未配置 git 身份时的作者邮箱。 */
  gitAuthorEmail: z.string().default(CONFIG_DEFAULTS.gitAuthorEmail),
  /** 成功后是否保留 staging 目录（便于排查）。 */
  keepStaging: z.boolean().default(CONFIG_DEFAULTS.keepStaging),
  /** 子代理提示词中列出的参考仓库（姐妹插件，工具链/格式/风格对照）。 */
  referenceRepos: z.array(z.string()).default(CONFIG_DEFAULTS.referenceRepos),
  /** staging 目录保留天数；超过则在下一次 forge 调用时清理；0 = 不清理（默认）。 */
  stagingTtlDays: z.natural().default(CONFIG_DEFAULTS.stagingTtlDays),
  /** 迁移并提交成功后装入的 profile 名（如 'web'）；留空 = 自动探测当前 profile。 */
  installProfile: z.string().default(CONFIG_DEFAULTS.installProfile),
  /** 迁移并提交成功后自动装入当前 profile（默认 true；install: false 参数可关闭）。 */
  autoInstall: z.boolean().default(CONFIG_DEFAULTS.autoInstall),
})

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  // M02：经 Config() 求值应用 schema 默认值（唯一真源），
  // 避免"直接 apply 路径绕过 schema、默认值两份漂移"。
  // schemastery z 对象运行时接受 Partial 并填充默认；类型侧以 Config 断言收窄。
  const merged: Config = Config(config as Config)
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

// ---- 公共导出（仅保留 scripts/宿主有实际消费者的符号；内部工具从各模块直接 import） ----
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
  runForge,
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
