# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

DeepSeek Harness（DSH）的**插件锻造厂**：为 AI 提供 `forge_plugin` 工具——传入需求后启动一个新 Agent，按姐妹插件仓库的工具链/格式/语言风格（并遵守用户全局 AGENTS.md）开发并构建验证 DSH 插件，完成后迁移为 `D:/2-OGP` 下的独立 git 仓库，并在**功能完成时立即做一次英文 Conventional Commit**（非定时提交）。仓库登记进 `$DSH_HOME/plugin-forge.json`，`/forge status` 可查询。

English: [README.en.md](README.en.md)

## 功能

### forge_plugin 工具（AI 可调用）

调用参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `requirement` | 是 | 插件需求（中文优先）：功能、行为、交互、配置等 |
| `name` | 否 | 插件/仓库目录名（kebab-case）；缺省时从需求自动生成 |
| `targetRoot` | 否 | 独立仓库所在根目录；缺省用配置的 `targetRoot`（默认 `D:/2-OGP`） |
| `migrate` | 否 | 是否迁移为独立 git 仓库并提交（默认 `true`） |
| `update` | 否 | 目标目录已存在时是否允许更新（默认 `false`，防误覆盖） |

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

### /forge status

会话内查询已创建的插件仓库：名称、路径、最近提交时间、累计提交次数。

## 配置

插件行（`cordis.patch.yml` 的 `plugin-forge` insert 行）支持以下可选 config：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetRoot` | `D:/2-OGP` | 独立仓库所在根目录 |
| `stagingRoot` | 空 | 子代理开发暂存根目录；留空 = 调用方工作区 `/.forge-staging` |
| `harnessRoot` | 空 | deepseek-harness 检出根；留空 = 从工作区向上自动查找 |
| `subagentProvider` | `spawn` | 子代理 provider 名（base bundle 内置） |
| `maxChildDepth` | `2` | 子代理最大委托深度（封顶防递归） |
| `childTimeoutMs` | `2700000` | 子代理及目标目录构建超时（毫秒，45 分钟） |
| `commitType` | `feat` | Conventional Commit 类型 |
| `push` | `false` | 是否提交后 push（默认不推送） |
| `gitAuthorName` / `gitAuthorEmail` | `csiroqa` / `justinwangyj@163.com` | 仓库未配置 git 身份时的作者回退 |
| `keepStaging` | `true` | 成功后是否保留 staging 目录（便于排查） |

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
3. 生成的插件在 `D:/2-OGP/<name>`，可像其他姐妹插件一样 `dsh plugin --profile web add link:D:/2-OGP/<name>` 装入使用

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
