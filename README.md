# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

DeepSeek Harness（DSH）的**插件锻造厂**：为 AI 提供 `forge_plugin` 工具——传入需求后启动一个新 Agent，按姐妹插件仓库的工具链/格式/语言风格（并遵守用户全局 AGENTS.md）开发并构建验证 DSH 插件，完成后迁移为**项目根（调用方工作区的父目录）`/dsh-plugins/<name>`** 下的独立 git 仓库，并在**功能完成时立即做一次英文 Conventional Commit**（非定时提交）。仓库登记进 `$DSH_HOME/plugin-forge.json`，`/forge status` 可查询。

English: [README.en.md](README.en.md)

## 功能

### forge_plugin 工具（AI 可调用）

调用参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `requirement` | 是 | 插件需求（中文优先）：功能、行为、交互、配置等 |
| `name` | 否 | 插件/仓库目录名（kebab-case）；缺省时从需求自动生成 |
| `targetRoot` | 否 | 独立仓库所在根目录；缺省用配置的 `targetRoot`（默认项目根（调用方工作区的父目录）`/dsh-plugins`） |
| `migrate` | 否 | 是否迁移为独立 git 仓库并提交（默认 `true`） |
| `update` | 否 | 目标目录已存在时是否允许更新（默认 `false`，防误覆盖） |
| `install` | 否 | 迁移并提交成功后是否自动装入 profile 立即可用（默认 `false`；需配置 `installProfile`，重启后生效） |
| `hot` | 否 | 迁移并提交成功后是否**热挂载**到当前运行时（默认 `false`；`true` = 无缝切换，当前会话立即获得新工具/命令，无需重启） |

执行流程：

1. 清理并重建 staging 目录（调用方会话工作区内 `/.forge-staging/<name>`，子代理沙箱可写）
2. 启动全新子代理（`spawn` provider，`maxChildDepth=2`：可再向下委托一层，同时封顶防递归），提示词内置：
   - 用户需求原文
   - 姐妹仓库规范：tsdown 双半区构建、pnpm@11.7.0、TypeScript strict、`cordis.patch.yml` insert 行、双语 README、LICENSE/CI 等
   - 用户全局 AGENTS.md 规则：中文沟通、小步修改、最小依赖、不隐藏失败、禁止提交敏感信息等
   - 环境约束：只写 staging、pnpm install 需网络、沙箱受限时的 `--store-dir` / `--ignore-scripts` 降级
3. 子代理完成（`completed`）后，把 staging 复制为 `targetRoot/<name>` 独立仓库：
   - 改写 `package.json` 中指向 deepseek-harness 的 `link:` 依赖为正确相对路径
   - 幂等补齐 `.gitignore`（node_modules/ 等）
   - 目标目录重新 `pnpm install && pnpm build` 验证迁移结果
4. **功能完成即提交**：`git init`（如无）→ `git add -A` → 检查 diff → 有变更则提交一次英文 Conventional Commit（如 `feat: web-search-memo: add keyword search for session memos`）；不 push（除非配置显式开启）
5. 登记进 `$DSH_HOME/plugin-forge.json`（原子写入）
6. **无缝切换（`hot: true`）**：动态 import 新插件的 `lib/index.js`（cache-busting 防模块缓存）并 `ctx.plugin()` 挂载到当前运行时——当前会话下一轮即可使用新工具/命令，**无需重启**；挂载前校验插件声明的 inject 服务当前运行时可用，不可用则拒绝并提示改走 `install: true`

### /forge status

会话内查询已创建的插件仓库：名称、路径、**HEAD 提交、工作区是否干净**、最近提交时间、累计提交次数。示例：

```text
plugin-forge 已创建的插件仓库（1 个）：
- plugin-forge（D:/2-OGP/plugin-forge）
  HEAD：f4e016c feat: add plugin-forge: agent-driven DSH plugin factory…；工作区：干净；最近提交：2026/7/8 05:43，累计 1 次
```

## 更新既有插件

再次调用 `forge_plugin` 并传 `update: true` 即可更新已存在的仓库（目标目录存在且未开 `update` 时会被拒绝，防止误覆盖）：

- 宿主会**预填充** staging（复制现有仓库源码），子代理只需做增量修改，不必重读重写全部文件
- 子代理在交付目录删除的文件，迁移时会**同步删除**目标仓库中的对应文件（防残留）
- 更新完成后同样立即提交一次并累计提交次数

## 自迭代：agent 自发调用（完整流程）

插件加载时会在系统提示词注册**自迭代引导节**，定义完整闭环：

1. **发现（执行中自我发现）**：AI 在完成用户任务的过程中自己判断——缺少完成任务所需的能力（工具/命令/自动化缺口）、只能靠笨办法重复劳动、或当前功能值得固化（重复出现、跨会话复用）且作为单个插件不会太重；**由 AI 决定缺什么、该补什么，无需用户提及插件**
2. **自发调用**：主动 call `forge_plugin`，不要只给建议（无需用户明确说"做插件"）
3. **交付**：子代理开发 → 构建验证 → 迁移独立仓库 → 功能完成即提交
4. **无缝切换**：传 `hot: true` 立即热挂载到当前运行时，本会话马上可用新能力（无需重启）；需要重启后也生效再传 `install: true` 装入 profile

## 自迭代工作流示例（设计意图）

```text
你（用户）：做一个插件，把每次会话结束时自动归档到本地文件夹
AI：调用 forge_plugin(requirement=..., name="session-auto-archive")
  → 新 Agent 开发、构建验证、迁移到项目根/dsh-plugins/session-auto-archive、提交
  → 返回：独立仓库 + 提交摘要
你（用户）：给 session-auto-archive 增加"归档后发送系统通知"功能
AI：调用 forge_plugin(requirement=..., name="session-auto-archive", update=true)
  → 预填充现有代码 → 增量修改 → 同步删除 → 再次提交
```

每个功能的完成都形成一次可回退提交；深度限制（`maxChildDepth=2`）保证迭代可控。

## 质量保障（迁移防线）

- 子代理构建验证（staging 内 `typecheck` / `test` / `build`）
- 迁移后目标目录重新 `pnpm install && pnpm build`
- 校验 `package.json` 的 `main` / `types` 指向的文件真实存在（防 `.mjs` 与声明不一致）
- 校验没有写成 registry 版本号的 `@deepseek-ai/*` 依赖（必须 `link:` 指向本地 deepseek-harness）
- 幂等补齐 `.gitignore`；提交前检查 diff；commit subject 按 Conventional Commits ≤72 字符清洗

## 配置

插件行（`cordis.patch.yml` 的 `plugin-forge` insert 行）支持以下可选 config：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetRoot` | 空 | 独立仓库所在根目录；留空 = 项目根（调用方工作区的父目录）`/dsh-plugins` |
| `stagingRoot` | 空 | 子代理开发暂存根目录；留空 = 调用方工作区 `/.forge-staging` |
| `harnessRoot` | 空 | deepseek-harness 检出根；留空 = 从工作区向上自动查找 |
| `subagentProvider` | `spawn` | 子代理 provider 名（base bundle 内置） |
| `maxChildDepth` | `2` | 子代理最大委托深度（封顶防递归） |
| `childTimeoutMs` | `2700000` | 子代理及目标目录构建超时（毫秒，45 分钟） |
| `commitType` | `feat` | Conventional Commit 类型 |
| `push` | `false` | 是否提交后 push（默认不推送） |
| `gitAuthorName` / `gitAuthorEmail` | `csiroqa` / `justinwangyj@163.com` | 仓库未配置 git 身份时的作者回退 |
| `keepStaging` | `true` | 成功后是否保留 staging 目录（便于排查） |
| `referenceRepos` | 4 个姐妹仓库 | 子代理提示词中列出的参考仓库（工具链/格式/风格对照） |
| `stagingTtlDays` | `0` | staging 保留天数；超过则在下一次 forge 调用时清理；`0` = 不清理 |
| `installProfile` | 空 | 迁移并提交成功后自动装入的 profile 名（如 `web`）；留空 = 不自动安装（默认关闭） |

## 安装

前置：Node.js >= 22、pnpm、本机 `deepseek-harness` 源码检出（依赖以 `link:` 指向 `../deepseek-harness`）。

```sh
git clone https://github.com/csiroqa/dsh-plugin-forge.git
cd dsh-plugin-forge
pnpm install
pnpm build

# 安装进 web profile（link: 指向本目录）
dsh plugin --profile web add link:$(pwd)        # POSIX
dsh plugin --profile web add link:D:\2-OGP\plugin-forge   # Windows
```

重启 `dsh web`，浏览器 **Ctrl+F5** 硬刷新。

## 使用

1. 在会话中直接对 AI 说需求，AI 会调用 `forge_plugin`（也可在提示词里显式要求调用）
2. 侧栏输入 `/forge status` 查看已创建的插件仓库与最近提交
3. 生成的插件在项目根（调用方工作区的父目录）`/dsh-plugins/<name>`，可像其他姐妹插件一样 `dsh plugin --profile web add link:<项目根>/dsh-plugins/<name>` 装入使用

## 真实 LLM 实例测试（无需重启 GUI）

在 GUI 重启加载 `forge_plugin` 之前，可用 `scripts/llm-e2e-host.mjs` 用**真实 LLM 子代理**走完整条流水线（子代理 = 会话级 subagent，宿主侧 = 本脚本复用 lib 同一批函数）。下方示例显式传了 targetRoot `D:/2-OGP`（演示显式覆盖）；不传时 forge 默认迁移到项目根（调用方工作区的父目录）`/dsh-plugins`：

```sh
# 1) 生成真实子代理提示词（<name> <stagingDir> <targetRoot> <harnessRoot> <requirement>）
node scripts/llm-e2e-host.mjs prompt demo-greet "D:\2-OGP\dsh-plugin\.forge-staging\demo-greet" "D:/2-OGP" "D:/2-OGP/deepseek-harness" "注册 /greet 命令……"
# 2) 把提示词交给一个真实 LLM 子代理执行（staging 目录内开发 + 构建验证）
# 3) 子代理完成后执行宿主侧全流程（迁移/link+CI 改写/构建/git 提交/登记）
node scripts/llm-e2e-host.mjs run demo-greet "D:\2-OGP\dsh-plugin\.forge-staging\demo-greet" "D:/2-OGP" "D:/2-OGP/deepseek-harness" "feat: demo-greet: ……"
```

## 设计意图：agent 自迭代

这是 DSH 内 agent「自迭代」闭环的起点：agent 通过 `forge_plugin` 按需生成/更新插件来扩展 DSH 自身能力，每个功能的完成都形成一次可回退的提交。深度限制（`maxChildDepth=2`）与「功能完成即提交」共同保证迭代可控、可审查。

## 安全说明

- `forge_plugin` 会启动子代理、执行 `pnpm install`（需要网络访问 npm registry）、在目标目录运行 `pnpm build`、执行 `git commit`——这些都是真实的主机操作，请只传入你信任的需求
- 提交遵循 AGENTS.md：先检查 diff、不提交敏感信息（.gitignore 兜底）、不自动 push/tag/release
- 子代理只允许写入 staging 目录（工作区内），无法写其他位置

## 兼容性

- **平台**：Windows / macOS / Linux（Node >= 22），三平台 CI 验证
- 针对 DSH `0.1.0-rc.5`+ 源码检出开发验证
- 构建产物：`tsdown`（host 半区 `lib/index.js`，标准 Node ESM）

## 许可与使用声明

**MIT License**（见 [LICENSE](LICENSE)），欢迎使用、修改、引用或收录进自己的插件合集。

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 同系列插件：[dsh-schedule](https://github.com/csiroqa/dsh-schedule)、[dsh-hotkeys](https://github.com/csiroqa/dsh-hotkeys)、[dsh-archive-viewer](https://github.com/csiroqa/dsh-archive-viewer)
