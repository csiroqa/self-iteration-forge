/**
 * plugin-forge —— DSH 插件锻造厂（host 半区）。
 *
 * 为 AI 提供 forge_plugin 工具：传入需求后启动全新子代理，按姐妹插件
 * 仓库的工具链/格式/语言风格（并遵守用户全局 AGENTS.md）开发并构建
 * 验证 DSH 插件，完成后迁移为 targetRoot 下的独立 git 仓库，并在功能
 * 完成时立即做一次英文 Conventional Commit（非定时提交），登记进
 * $DSH_HOME/plugin-forge.json；/forge status 可查询已建仓库。
 *
 * 设计意图：这是 DSH 内 agent「自迭代」闭环的起点——agent 可以按需
 * 生成/更新插件来扩展 DSH 自身能力。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerForgeCommand, registerForgeTool, type ForgeConfig } from './forge.ts'

export const name = 'plugin-forge'

/** 需要注入的服务：工具注册表、子代理运行时、命令注册表。 */
export const inject = ['tools', 'subagents', 'commands']

/** 配置（默认值即出厂值；cordis.patch.yml 的 config 可覆盖）。 */
export interface Config extends ForgeConfig {}

export const Config: z<Config> = z.object({
  /** 独立仓库所在根目录。 */
  targetRoot: z.string().default('D:/2-OGP'),
  /** staging 根目录；留空 = 父会话工作区/.forge-staging。 */
  stagingRoot: z.string().default(''),
  /** deepseek-harness 检出根；留空 = 从工作区向上自动查找。 */
  harnessRoot: z.string().default(''),
  /** 子代理 provider 名。 */
  subagentProvider: z.string().default('spawn'),
  /** 子代理最大委托深度：2 = 子代理还能再向下委托一层，同时封顶防递归。 */
  maxChildDepth: z.natural().min(1).max(5).default(2),
  /** 子代理及目标目录构建的超时（毫秒），默认 45 分钟。 */
  childTimeoutMs: z.natural().min(60_000).default(2_700_000),
  /** Conventional Commit 类型。 */
  commitType: z.string().default('feat'),
  /** 是否提交后 push（默认 false，遵守 AGENTS.md 不自动 push）。 */
  push: z.boolean().default(false),
  /** 仓库未配置 git 身份时的作者名。 */
  gitAuthorName: z.string().default('csiroqa'),
  /** 仓库未配置 git 身份时的作者邮箱。 */
  gitAuthorEmail: z.string().default('justinwangyj@163.com'),
  /** 成功后是否保留 staging 目录（便于排查）。 */
  keepStaging: z.boolean().default(true),
  /** 子代理提示词中列出的参考仓库（姐妹插件，工具链/格式/风格对照）。 */
  referenceRepos: z.array(z.string()).default([
    'D:/2-OGP/dsh-schedule',
    'D:/2-OGP/dsh-hotkeys',
    'D:/2-OGP/dsh-plugin/plugins/system-notify',
    'D:/2-OGP/dsh-plugin/plugins/command-opt',
  ]),
  /** staging 目录保留天数；超过则在下一次 forge 调用时清理；0 = 不清理（默认）。 */
  stagingTtlDays: z.natural().default(0),
})

/** 直接 apply()（不经 loader）时也保证字段齐全。 */
const DEFAULTS: Config = {
  targetRoot: 'D:/2-OGP',
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
  referenceRepos: [
    'D:/2-OGP/dsh-schedule',
    'D:/2-OGP/dsh-hotkeys',
    'D:/2-OGP/dsh-plugin/plugins/system-notify',
    'D:/2-OGP/dsh-plugin/plugins/command-opt',
  ],
  stagingTtlDays: 0,
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const merged: Config = { ...DEFAULTS, ...config }
  registerForgeTool(ctx, merged)
  registerForgeCommand(ctx)
  ctx.logger.info('plugin-forge 已加载：forge_plugin 工具与 /forge status 命令可用（targetRoot=%s）', merged.targetRoot)
}

// ---- 供 smoke/单元测试复用的纯函数导出 ----
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
  isGitRepo,
  resolveIdentity,
  stageAll,
  type GitIdentity,
} from './git.ts'
export {
  loadRegistry,
  saveRegistry,
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
  cleanSummaryEn,
  buildCommitSubject,
  fnv1a,
  samePath,
  type ExecResult,
} from './utils.ts'
export {
  parseChildReport,
  runForge,
  cleanupStaleStaging,
  assertNoRegistryHarnessDeps,
  verifyBuildInTarget,
  type ChildReport,
  type ForgeArgs,
  type ForgeLogger,
  type ForgeToolResult,
  type StartChild,
} from './forge.ts'
export { buildChildPrompt, type ChildPromptContext } from './prompt.ts'
