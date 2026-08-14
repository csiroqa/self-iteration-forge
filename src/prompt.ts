/**
 * plugin-forge —— 子代理提示词构建。
 *
 * 提示词是 forge 的"灵魂"：把用户需求 + 姐妹插件仓库的工具链/格式/
 * 语言风格约定 + 用户全局 AGENTS.md 规则 + 环境约束一次性交给全新子代理，
 * 并要求以固定 REPORT 块汇报，便于宿主解析摘要用于英文 Conventional Commit。
 */
import { toPosix } from './utils.ts'

/** 构建子代理提示词所需的上下文。 */
export interface ChildPromptContext {
  /** 用户传入的插件需求原文。 */
  readonly requirement: string
  /** kebab-case 插件名（同时是目录名）。 */
  readonly name: string
  /** staging 目录绝对路径（子代理只能写这里）。 */
  readonly stagingDir: string
  /** deepseek-harness 检出根绝对路径。 */
  readonly harnessRoot: string
  /** 从 stagingDir 到 harnessRoot 的相对 link: 前缀（如 ../../../deepseek-harness）。 */
  readonly relativeHarnessPath: string
  /** 迁移目标根目录（独立仓库所在）。 */
  readonly targetRoot: string
  /** 参考仓库（姐妹插件）绝对路径列表，用于工具链/格式/风格对照。 */
  readonly referenceRepos: readonly string[]
}

/** 组装完整子代理提示词（中文，遵循用户全局 AGENTS.md 语言约定）。 */
export function buildChildPrompt(context: ChildPromptContext): string {
  const { requirement, name, stagingDir, harnessRoot, relativeHarnessPath, targetRoot, referenceRepos } = context
  const referenceList = referenceRepos.length > 0
    ? referenceRepos.map((repo) => `- ${toPosix(repo)}`).join('\n')
    : '- （未配置参考仓库；直接对照 dsh-schedule / dsh-hotkeys 的通用结构）'
  return `# 任务：开发一个 DSH（DeepSeek Harness）插件

你是一个 DSH 插件开发 Agent。请根据下面的「需求」，在指定工作目录中从零开发一个完整、可构建、可安装的 DSH 插件，完成构建验证，并按规定格式汇报。全程自主完成，不要提问，不要使用 ask_user。

## 需求

${requirement}

## 交付目录（只允许写这里，禁止写目录外任何文件）

${toPosix(stagingDir)}

## 必须遵循的规范（用户全局 AGENTS.md + 姐妹插件仓库约定）

### 工具链（与姐妹仓库一致）
- Node >= 22；pnpm@11.7.0（package.json 的 packageManager 字段）；TypeScript strict；tsdown 构建；vitest 测试（如适合）。
- 包名：@dsh-external/${name}。
- 依赖一律写成 "link:<相对路径>/…" 指向本地 deepseek-harness 检出（见下），禁止写 npm registry 版本号。

### 仓库格式（逐项对照姐妹仓库，开发前先通读参考仓库）
- package.json：private、type module、main/types 指向 lib/index.js|d.ts、exports（"." 与 "./package.json"，如有浏览器半区再加 "./client"）、dsh.bundle.patch=./cordis.patch.yml（如有浏览器半区再加 dsh.client 声明）、scripts（build=tsdown、typecheck=tsc --noEmit、test=vitest run、watch=tsdown --watch）、keywords、author "csiroqa <justinwangyj@163.com>"、license MIT、engines node>=22、files（lib、src、cordis.patch.yml）。
- tsconfig.json：参照姐妹仓库（target ES2022、moduleResolution bundler、strict、types:["node"]、allowImportingTsExtensions 等）。
- tsdown.config.ts：host 半区产出 lib/index.js（ESM、dts、neverBundle 全部 @deepseek-ai/* link 依赖、fixedExtension: false——确保产出 index.js 而非 index.mjs，与 package.json 的 main/types 一致）；如有浏览器半区，按姐妹仓库的闭包工厂配置（window.__ModuleLoader__.load）再产出 lib/client.js，平台 externals 与 dsh-schedule/dsh-hotkeys 一致。
- cordis.patch.yml：- insert: - id: ${name} / name: '@dsh-external/${name}' / config: {...}，并用中文注释说明每个配置项。
- src/index.ts：export const name = '${name}'；export const inject = [所需服务]；export function apply(ctx, config)；如有配置用 @deepseek-ai/schemastery 的 z 定义 Config（z<Config> 模式见 @deepseek-ai/dsh-tool-subagent）。
- 浏览器半区（仅当需求需要 UI）：src/client/index.ts + package.json 的 dsh.client（platform: web，inject @deepseek-ai/dsh-client-runtime）。
- README.md（中文）+ README.en.md（英文，互链一行）+ LICENSE（MIT，Copyright (c) 2026 csiroqa）+ .editorconfig + .gitattributes + .gitignore（node_modules/、lib/、dist/、*.tsbuildinfo、*.log、.DS_Store、Thumbs.db）+ .github/workflows/ci.yml（3 OS 矩阵：clone 兄弟 deepseek-harness → pnpm install → typecheck → test → build → smoke）。
- 代码注释用中文；UX 文案按 AGENTS.md：用户引导文本不暴露实现细节，错误提示给建议 + 适量调试信息。

### 参考仓库（先通读再动手）

${referenceList}

### 依赖链接约定
deepseek-harness 检出位于 ${toPosix(harnessRoot)}。从交付目录到它的相对前缀已算好：${relativeHarnessPath}。
所有 @deepseek-ai/* 依赖写成 "link:${relativeHarnessPath}/vendor/cordis"、"link:${relativeHarnessPath}/packages/core/tools" 这类形式（具体子路径按需，可参考姐妹仓库 package.json 的依赖清单）。
禁止把 @deepseek-ai/* 写成 registry 版本号（如 "^1.0.0"）——宿主会在迁移时校验并拒绝。

### AGENTS.md 规则（必须遵守）
- 小步修改、清晰实现、最小依赖；不擅自大改架构；不要引入没有必要的抽象。
- 不隐藏失败：安装/构建/类型检查失败必须如实报告并修复，不得谎报成功。
- 禁止提交或生成：密钥、Token、Cookie、.env、个人敏感信息、调试输出。
- 不添加遥测、追踪、第三方上报。
- 不要使用 any 或 @ts-ignore 掩盖类型问题；不要删除测试来"让构建通过"。

### 环境约束
- 你的文件沙箱是 workspace-write：只有交付目录（位于工作区内）可写。
- pnpm install 需要网络（npm registry）；若全局 store 写入被沙箱拒绝，改用 --store-dir ${toPosix(stagingDir)}/.pnpm-store 重试；若生命周期脚本被拒，再加 --ignore-scripts。
- 不要执行 git 命令（init/add/commit 由宿主 forge 完成）；不要删除交付目录；不要写交付目录以外的任何文件。

## 开发步骤

1. 用 read/glob/grep 通读参考仓库与所需 API 源码，确认工具链与格式细节。
2. 设计插件：功能、注入的服务、配置项、是否需要浏览器半区、注册哪些工具/命令。
3. 在交付目录创建全部文件（文件清单见「仓库格式」）。
4. 安装依赖：pnpm install（必要时加 --store-dir / --ignore-scripts）。
5. 构建验证：pnpm typecheck、pnpm test（如写了测试）、pnpm build，修复到全部通过；脚本不存在的检查如实标注 skipped。
6. 自查：文件齐备、命名规范、无敏感信息、.gitignore 覆盖 node_modules 等。
7. 汇报。

## 最终报告（最后一条消息必须包含以下固定格式块，便于宿主解析）

REPORT_START
plugin_name: ${name}
summary_zh: <一句话中文功能摘要>
summary_en: <一句话英文摘要，只含可打印 ASCII、无换行，≤72 字符，用于 Conventional Commit，如 "add keyword search for session memos">
requires_client: <true|false>
build: <passed|failed>
typecheck: <passed|failed|skipped>
test: <passed|failed|skipped|none>
files: <逗号分隔的相对路径清单>
notes: <补充说明：已知限制、网络使用情况、安装方式建议等>
REPORT_END

注意：REPORT 块之外可以自由说明过程；迁移目标（${toPosix(targetRoot)}/${name}）与 git 提交由宿主完成，你不需要关心。`
}
