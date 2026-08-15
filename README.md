# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

AI-native DSH 插件生成器。`forge_plugin` 由 AI 在执行任务时调用：子代理开发 → 迁移为「项目根/dsh-plugins/<name>」独立 git 仓库（功能完成即英文 Conventional Commit）→ 热挂载当前会话。

English: [README.en.md](README.en.md)

## 工具 `forge_plugin`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `requirement` | string | 必填 | 插件需求（中文优先，尽量具体） |
| `name` | string | 自动 | 仓库目录名（kebab-case，从需求派生） |
| `targetRoot` | string | 项目根/dsh-plugins | 迁移根目录（参数 > 配置 > 默认） |
| `migrate` | boolean | `true` | 迁移为独立仓库并提交 |
| `update` | boolean | `false` | 更新既有仓库（防误覆盖） |
| `install` | boolean | 缺省自动 | 装入 profile：缺省自动装入当前 profile；`false` 关闭；`installProfile` 可显式指定 |
| `hot` | boolean | `true` | 热挂载到当前运行时 |

输出 JSON：

| 字段 | 说明 |
| --- | --- |
| `ok` `pluginName` `committed` `build` `files` | 必填；`build` = `passed` / `skipped` / 失败原因 |
| `migratedTo` | 仓库绝对路径（正斜杠）；`migrate=false` 时缺省 |
| `commitSubject` | 提交 subject；未提交时缺省 |
| `childReport` | 子代理 REPORT notes（截断 500 字符） |
| `installed` `installDetail` `hotMounted` `hotDetail` | profile 装入（`installed=false` 时 `installDetail` 为未装入原因）/ 热挂载结果；两者失败均不阻塞交付 |
| `duplicated` `existingName` | 子代理判定与既有插件重复：拒绝新建，返回既有仓库名 |

失败（子代理未完成 / 迁移后构建失败 / 加载冒烟未通过）throw，staging 保留。

## 命令 `/forge status`

逐仓库输出：

```
- <name>（<path>）
  HEAD：<短哈希> <subject>；工作区：干净|有未提交改动|目录不存在；最近提交：<本地时间>，累计 <n> 次
```

registry 为空时输出「plugin-forge 尚未创建任何插件仓库。」

## 流程

staging → 子代理开发（typecheck/test/build）→ 重复检测 → 迁移 → 目标重建 → 加载冒烟 → git init/commit → 登记 → 装入 profile（缺省自动）→ 热挂载。

- staging：`<stagingRoot>/<name>`，默认 `工作区/.forge-staging/<name>`；子代理仅写此处
- 同名任务进程内互斥；`stagingTtlDays > 0` 时启动前清理过期目录
- 迁移：link/CI 中 `deepseek-harness` 路径按深度改写、拒绝 registry 版 `@deepseek-ai/*` 依赖、写入 .gitignore（排除 node_modules/.git/.pnpm-store/lib/dist）
- 更新模式额外 `syncRemoveStale`：删除目标中 staging 已不存在的源文件
- 提交：`<type>: <name>[: <summaryEn>]`，header ≤ 72 字符，summary 超预算截断；type 非法回退 `feat`
- 登记：`$DSH_HOME/plugin-forge.json`，形状 `{version: 1, repos: [{name, path, createdAt, lastCommitAt?, commitCount, summaryZh?}]}`，tmp+rename 原子写
- push 仅配置显式开启时执行（默认关，遵守 AGENTS.md）

## 防重复

引导节不注入插件清单（省上下文）。子代理开发前自检：读 registry 与 `dsh-plugins/` 目录，需求重复则 REPORT `duplicate_of` → 宿主拒绝新建，返回 `duplicated: true` + `existingName`；迭代走 `update=true`。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetRoot` | `''` | 迁移根；空 = 工作区父目录/dsh-plugins |
| `stagingRoot` | `''` | staging 根；空 = 工作区/.forge-staging |
| `harnessRoot` | `''` | deepseek-harness 检出根；空 = 自动查找 |
| `subagentProvider` | `spawn` | 子代理 provider |
| `maxChildDepth` | `2` | 子代理委托深度上限（1–5） |
| `childTimeoutMs` | `2700000` | 子代理/构建超时（≥ 60000） |
| `commitType` | `feat` | Conventional Commit 类型 |
| `push` | `false` | 提交后 push |
| `gitAuthorName` | `csiroqa` | 提交作者名 |
| `gitAuthorEmail` | `justinwangyj@163.com` | 提交作者邮箱 |
| `keepStaging` | `true` | 保留 staging 供排查 |
| `stagingTtlDays` | `0` | staging 保留天数；0 = 不清理 |
| `installProfile` | `''` | 装入的 profile 名；空 = 自动探测当前 profile |
| `autoInstall` | `true` | 成功后自动装入当前 profile（`install: false` 参数可关闭单次） |

## 质量门

staging 内 typecheck/test/build → 迁移后目标 `pnpm install && pnpm build` → main/types 存在 → 拒绝 registry 版 `@deepseek-ai/*` → **加载冒烟**（真实 cordis Context 执行 apply，拦截 apply 期崩溃——真实事故：命令 `input.hint` 为空导致 DSH 启动即崩）→ **宿主工具名冲突拦截**（机制确认：dsh-tools 跨 scope 同名注册不报错但模型侧遮蔽；加载冒烟与热挂载双重拦截）→ 提交前检查 diff。

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:D:\2-OGP\plugin-forge
```

重启 `dsh web`。前置：Node ≥ 22、pnpm、本地 deepseek-harness 检出（依赖 link: `../deepseek-harness`）。

## 交付方式

1. 热挂载（默认）：生成后挂载当前运行时，本会话即用
2. 装入 profile（缺省自动）：探测当前 profile（`installProfile` 可显式指定），重启生效
3. repository 源（家目录层 plugin-console）：`$DSH_HOME/cordis.patch.yml` 的 `repository-plugins.repositories`，面板行管理——添加=安装、更新=锁定远端最新 commit、删行=卸载、立即生效；行格式 `github:owner/repo#ref`（monorepo 子包加 `&path:/packages/<子包>`）。forge 产物是单包独立仓库，push 后可直接作源；`update=true` 迭代 push 后面板更新即拉新 commit

## 真实 LLM 测试（免重启 GUI）

```sh
node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> "<需求>"
node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> "feat: <name>: <摘要>"
```

`prompt`：生成真实子代理提示词；`run`：执行宿主侧全流程（迁移/link+CI 改写/构建/提交/登记）；`--update` 走更新链路。

## 安全

- forge 启动子代理、联网 pnpm install、目标目录构建、执行 git commit——只传可信需求
- 提交前 diff 检查、.gitignore 排除构建产物与依赖、不自动 push/tag/release
- 子代理只写 staging（工作区内）

## 演示

[docs/demo-1.png](docs/demo-1.png) · [docs/demo-2.png](docs/demo-2.png)
