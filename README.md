# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

AI-native 的 DSH 插件锻造厂。`forge_plugin` 工具让 AI 自主闭环：**主动使用是 AI 的默认工作方式**——执行任务中一旦发现能力缺口或重复劳动，立即调用（调用是任务的一部分，不只给建议）→ 子代理开发 → 迁移为项目根 `/dsh-plugins/<name>` 独立 git 仓库（功能完成即英文 Conventional Commit）→ 自动热挂载本会话即用。人类只需自然表达需求，无需提及"插件"。

English: [README.en.md](README.en.md)

## 用法

AI 调用 `forge_plugin`，参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `requirement` | 是 | 插件需求（中文优先） |
| `name` | 否 | 仓库名（kebab-case）；缺省自动生成 |
| `targetRoot` | 否 | 迁移根目录；缺省项目根/dsh-plugins |
| `update` | 否 | 更新既有仓库（默认 false，防误覆盖） |
| `install` | 否 | 装入 profile（默认 false，需配置 installProfile） |
| `hot` | 否 | 热挂载到当前运行时（默认 true；false 关闭） |

流程：staging（工作区 `/.forge-staging`）→ 子代理开发并构建验证 → 迁移（link/CI 路径改写、依赖守卫、加载冒烟）→ git init/add/diff/commit → 登记 `$DSH_HOME/plugin-forge.json` → 热挂载。

`/forge status`：查看已建仓库（HEAD、工作区状态、提交次数）。

## 防重复

引导节不注入插件清单（省上下文）。子代理开发前自检：读 registry 与 `dsh-plugins` 目录，需求与已有插件重复则报告 `duplicate_of`，宿主拒绝新建并返回 `existingName`，改走 `update=true`。

## 配置（cordis.patch.yml，全部可选）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetRoot` | 空 | 迁移根目录；空 = 工作区父目录/dsh-plugins |
| `stagingRoot` | 空 | staging 根；空 = 工作区/.forge-staging |
| `harnessRoot` | 空 | deepseek-harness 检出根；空 = 自动查找 |
| `installProfile` | 空 | install:true 时装入的 profile 名 |
| `commitType` | `feat` | Conventional Commit 类型 |
| `push` | `false` | 提交后是否 push |
| `maxChildDepth` | `2` | 子代理委托深度上限 |
| `childTimeoutMs` | `2700000` | 子代理/构建超时 |
| `keepStaging` | `true` | 保留 staging 便于排查 |
| `stagingTtlDays` | `0` | staging 保留天数；0 = 不清理 |

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:D:\2-OGP\plugin-forge
```

重启 `dsh web`。前置：Node >= 22、pnpm、本地 `deepseek-harness` 检出（依赖以 link: 指向 `../deepseek-harness`）。

## 质量保障

staging 内 typecheck/test/build → 迁移后目标目录重装重建 → main/types 存在校验 → 拒绝 registry 版 `@deepseek-ai/*` 依赖 → **加载冒烟**（真实 cordis Context 执行 apply，拦截"构建通过但启动即崩"的 apply 期错误）→ 提交前检查 diff。

## Repository 机制配合

家目录层还有第三方 plugin-console 的 repository 插件机制（`$DSH_HOME/cordis.patch.yml` 的 `repository-plugins.repositories`）：面板行管理，添加=安装、更新=锁定远端最新 commit、删行=卸载、立即生效。行格式 `github:owner/repo#ref`（monorepo 子包加 `&path:/packages/<子包>`）。forge 产物是单包独立仓库，push 到 GitHub 后即可直接作为源添加；后续 `update=true` 迭代 push 后面板更新即拉到新 commit。

三种交付：热挂载（默认，本会话即用）/ install（profile，重启生效）/ repository 源（家目录层，正式分发）。

## 真实 LLM 测试（无需重启 GUI）

`scripts/llm-e2e-host.mjs`：`prompt` 模式生成真实子代理提示词，`run` 模式执行宿主侧全流程（迁移/link+CI 改写/构建/git 提交/登记；`--update` 走更新链路）。示例显式传 `targetRoot` 演示覆盖。

```sh
node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> "<需求>"
node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> "feat: <name>: <摘要>"
```

## 安全

- forge 会启动子代理、联网 pnpm install、在目标目录构建、执行 git commit——只传可信需求
- 提交前检查 diff、.gitignore 兜底、不自动 push/tag/release
- 子代理只写 staging（工作区内）
