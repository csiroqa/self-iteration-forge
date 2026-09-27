# 代码审查报告：self-iteration-forge

- 审查日期：2026-08-15
- 审查方式：多维度子代理并行审查
- 审查文件数：25
- 严重度过滤：无（显示全部）

## 总体统计

| 维度 | 问题总数 |
| --- | --- |
| Bug | 5 |
| Perf | 3 |
| Maintenance | 7 |
| DeadCode | 3 |
| 合计 | 18 |

> 各维度问题均按严重度 S → M → L 排序。`failed` 表示该维度子代理未正常完成，不影响其余维度。

## Bug
### B01 · M
- 位置：`src/verify-load.ts:83`
- 描述：`verifyPluginLoad` 用真实 cordis `Context` 加载并执行插件 `apply`，但创建的 Context 从未被释放。cordis Context 持有事件发射器、fiber、服务条目等资源；每次 forge 交付都会调用一次本函数，长期运行、多次生成插件的宿主进程中会累积未回收的 Context，属于资源泄漏。
### B02 · M
- 位置：`src/migrate.ts:119`
- 描述：`rewriteCiHarnessPaths` 的正则 `/(\.\.\/)+deepseek-harness/g` 只匹配"以 `../` 前导"的前斜杠写法，未匹配反向斜杠（Windows）或 `./`/无前缀/`$(PWD)` 拼接等其它合法引用形态。一旦子代理在 ci.yml 里写成 Windows 风格的反斜杠路径（Windows 上 agent 常见），或写成不含 `../` 前导的引用，本函数会静默返回 0 且不报错，CI 克隆到错误位置。
### B03 · M
- 位置：`src/utils.ts:63`
- 描述：Windows 下 `pnpm`/`npm`/`npx`/`dsh` 经 `cmd.exe` 中转运行，`execFile` 同传 `timeout` 与 `signal`；当超时或外部 abort 触发时，Node 只会 `kill` 掉被直接 spawn 的 `cmd.exe` 进程，而它再子启的 pnpm/node 进程不在进程树内被一并清除。节点应用（pnpm install/build）可能成孤儿进程继续占用 CPU/文件锁，甚至写锁残留导致下次重试失败。
### B04 · L
- 位置：`src/git.ts:29`
- 描述：`resolveIdentity` 用 `(^|\n)user\.name=` 等正则判断是否"已配置"身份，但它只检验键是否存在，不校验值非空。若 git 配置里存在空值的 `user.name=`/`user.email=`，hasName/hasEmail 均为 true，函数返回 `undefined`，上层据此放弃注入回退身份，最终 `git commit` 失败并报"user.name 为空"。
### B05 · L
- 位置：`src/hotmount.ts:39`
- 描述：热挂载 `loadPluginLib` 用唯一 query-string 后缀做 ESM cache-busting（`?${tag}=${Date.now()}-${mountSeq++}`），Node 会把每个唯一 URL 的模块永久留在模块缓存中。同一次宿主运行内每次热挂载都会新增一个不被淘汰的模块条目。

## Perf
### P01 · M
- 位置：`src/hotmount.ts:39`
- 描述：`loadPluginLib` 以 `Date.now()-$mountSeq` 生成每次调用都唯一的 query 作为 ESM cache-busting 后缀，使得每次 `import(url)` 都是全新的模块 URL。Node 的 ESM 模块注册表（ModuleMap）按完整 URL（含 query）缓存且进程生命周期内从不释放，因此每挂载/校验一次，旧 `lib/index.js` 模块实例就会被永久保留，无法被 GC。代码注释也确认了这一点（"同一路径反复 import 命中 ESM 缓存，更新后必须强制新实例"），但代价是长期运行的 host 进程中每次热挂载都累积一个模块条目。
### P02 · L
- 位置：`src/forge.ts:431`
- 描述：update 模式下 `runForgeLocked` 先 `copyInto(target, staging)` 把既有仓库整树拷贝到 staging 供子代理预填，随后 `migrateAndCommit`（第 568 行）又 `copyInto(staging, migratedTo)` 把 staging 整树拷回 target。一次更新会对同一份源文件做两趟全量目录复制（create 模式仅一趟），产生无谓的重复 IO。
### P03 · L
- 位置：`src/migrate.ts:160`
- 描述：`syncRemoveStale` 递归遍历 target 目录时，对每一个源文件都发起一次 `pathExists(sourceFull)`（即 `access()` 系统调用）去探测 staging 对应目录里是"文件还是空目录"，源码侧随之被隐式反复 `stat/访问`。文件数量为 N 时产生约 N 次同步 fs 系统调用，且在遍历 target 之外又反向上溯访问 source 的子树。

## Maintenance
### M01 · M
- 位置：`src/forge.ts:190-208`
- 描述：提示词协议（prompt.ts）要求子代理必须上报 `plugin_name`、`build`、`typecheck`、`test` 四个字段，但 `parseChildReport` 完全不解析它们；反向地，解析器建模并解析了 `requires_client`（L203）与 `files`（L201），却全程无任何消费者读取这两个字段（`summary_en`/`summary_zh`/`duplicate_note` 均有消费方，唯独这两个没有）。
### M02 · M
- 位置：`src/index.ts:28-45`
- 描述：同一套字段默认值以三份形态存在：`DEFAULTS` 常量、`Config` schema 的 `.default(DEFAULTS.x)`、以及 `cordis.patch.yml` 的 `config` 段（后者逐字硬编码了一份）。而 `apply()` 里实际生效路径是 `{ ...DEFAULTS, ...config }`（src/index.ts:79），根本没有调用 `Config` schema 来求默认值——schema 的默认在 apply 路径上是死代码；真正被依赖的是 `DEFAULTS` 与 yml。
### M03 · M
- 位置：`src/forge.ts:689-707`
- 描述：`registerForgeTool` 的 `output.schema.properties` 逐字段手工列出 `ok/pluginName/migratedTo/committed/commitSubject/build/files/childReport/error/installed/hotMounted/hotDetail/duplicated/existingName`，与 `ForgeToolResult` 接口（L127-154）为一组字段的两份维护源；`renderResult`（L236-267）消费的是接口类型，schema 却为独立手写。两处均由注释维护同一契约。
### M04 · M
- 位置：`src/forge.ts:403-526`
- 描述：虽已拆出 `migrateAndCommit`（较旧版本已有改善），但 `runForgeLocked` 仍串起 ≥8 个职责：staging 清理（L417）、目标守卫（L420-424）、staging 重建与 update 预填充（L431-433）、提示词组装与子代理启动（L436-451）、重复检测分支（L463-475）、文件清单（L478-481）、migrateAndCommit（L489-508）、keepStaging 收尾（L511-513）。`mode`/`migrate`/`update`/`targetExists`/`stagingTarget`/`files` 等大量状态跨 if 分支累积，测试只能端到端跑全流程，无法对单一阶段注入失败。
### M05 · M
- 位置：`src/index.ts:92-141`
- 描述：约 50 行 re-export 通过插件的 `exports: "."` 暴露大量实现工具（`runCommand`、`findHarnessRoot`、`samePath`、`toPosix`、`resolveTargetRoot`、`cleanupStaleStaging`、`rewriteHarnessLinks` 等），代码注释自述「供 smoke/单元测试复用」。这些是 `lib/index.js` 的公开导出面，内部改名即成对 consumers 的破坏性变更。
### M06 · L
- 位置：`src/verify-load.ts:16-58`
- 描述：`COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`、hint/description 非空校验等是对 `deepseek-harness/packages/interaction/commands` 的 `normalizeDefinition` 的逐字复刻（当前与真身一致），但文件头注释已自我提醒「harness 侧改动规则时需同步本文件，建议在 CI 中加一条'与 harness 规则一致性'对照测试」——该对照测试目前不存在于 .github/workflows/ci.yml。
### M07 · L
- 位置：`src/forge.ts:270-302`
- 描述：两者都是「对已迁移插件做交付前校验」，但契约不同：`verifyBuildInTarget` 用 `'passed'` 或 `'failed: <原因>'` 的字符串编码状态，调用方只能靠 `build !== 'passed'` 的字符串比较判定；`verifyPluginLoad` 则返回结构化 `{ ok, detail }`。同类副职能/失败信息用两种模式表达，读者与调用方需记住两种约定。

## DeadCode
### D01 · L
- 位置：`src/forge.ts:113`
- 描述：`ChildReport.requiresClient` 字段被 `parseChildReport` 解析并赋值，但全仓库（ts 源 + mjs 脚本）**从未读取**该字段——只写不读，是真正的死字段。配套协议字段 `requires_client:`（src/prompt.ts:118 要求子代理上报）同样被宿主忽略。
### D02 · L
- 位置：`src/forge.ts:110`
- 描述：`ChildReport.files` 字段被 `parseChildReport` 解析并写入，但宿主**从不读取**——文件名清单实际由宿主端 `listRelativeFiles(staging)` 独立枚举（src/forge.ts:478），子代理上报的文件清单是冗余数据。
### D03 · L
- 位置：`src/git.ts:11`
- 描述：以下函数带 `export` 关键字成为公共导出面，但全仓库（ts 源 + mjs 脚本 + specs）均无任何跨模块消费者，仅在其所在模块内部被调用——`export` 修饰符是无人消费的死表面：

## 附录：审查范围说明

- 单文件行数上限：1500
- 待审查源文件清单（25）：

- .github/workflows/ci.yml
- LICENSE
- README.en.md
- README.md
- cordis.patch.yml
- docs/review-2026-08-15-plugin-trial.md
- docs/review-2026-08-15.md
- package.json
- scripts/llm-e2e-host.mjs
- scripts/smoke.mjs
- src/forge.integration.spec.ts
- src/forge.ts
- src/git.ts
- src/hotmount.spec.ts
- src/hotmount.ts
- src/index.spec.ts
- src/index.ts
- src/migrate.ts
- src/prompt.ts
- src/registry.ts
- src/utils.ts
- src/verify-load.spec.ts
- src/verify-load.ts
- tsconfig.json
- tsdown.config.ts