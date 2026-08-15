# plugin-forge 第二轮多维度代码审查 — 2026-08-15

四维并行子代理审查（Bug / Perf / Maintenance / DeadCode）+ 主代理交叉复核勘误。第一轮审查与修复之后（`9c50e31`、`07dc333`）的二次体检。

- 审查对象：`@dsh-external/plugin-forge`（工作区 `D:\2-OGP\plugin-forge`）
- 范围：`src/*.ts` + `.spec.ts` + `scripts/` + `docs/`
- 方法：4 个独立子代理并行出报告 → 主代理逐条对照源码复核、去重、勘误 → 汇总可执行修复项
- 状态：下述"采纳"项已在本轮修复提交中落地（见末尾），"评估后跳过"项说明理由。

---

## 维度汇总（复核后）

### Bug（2 M / 3 L）
| # | 严重度 | 位置 | 问题 | 处置 |
|---|--------|------|------|------|
| B-R2-1 | M | utils.ts:141-158 | `runCommand` 按 chunk `toString('utf8')` 逐段解码，UTF-8 多字节落在 chunk 边界时被分裂成 `\ufffd`（已 Node 探针复现），污染 git log/status、install 报错的展示文本 | ✅ 采纳 |
| B-R2-2 | M | forge.ts:99-100,406-415 | `activeForge` 互斥的 `finally delete` 依赖 `runForge` 最终 settle；子代理在取消/超时时不收敛则互斥永久占用该插件名 | ✅ 采纳（signal 守卫兜底） |
| B-R2-3 | M | forge.ts:294-312 | `verifyBuildInTarget` 的 main/types 存在性检查仅在 `package.json` 存在时执行，且允许解析到包目录外/缺失时静默放行 | ✅ 采纳（收紧 + 逃逸检测） |
| B-R2-4 | L | migrate.ts:174 | `rewriteCiHarnessPaths` 第二分支 `(?<=[:=]\s*)deepseek-harness` 会改写 `--dir=deepseek-harness` 之类非路径标识 | ✅ 采纳（收紧 lookahead） |
| B-R2-5 | L | migrate.ts:110-113 | `rewriteHarnessLinks` 用 `indexOf('deepseek-harness')` 猜边界，遇同名子串（如 `-helper`）前缀错位 | ◻️ 评估后跳过（标准形态不受影响，改绝对路径解析风险>收益） |
| B-R2-6 | L | hotmount.ts:59-68 | `ctx.get(service)===undefined` 可能误判懒/未初始化服务而拒绝热挂载 | ◻️ 评估后跳过（正是为规避静默挂起的有意防御） |

### Perf（1 M / 4 L）
| # | 严重度 | 位置 | 问题 | 处置 |
|---|--------|------|------|------|
| P-R2-1 | M | migrate.ts:244-251 | `hasSourcePrefix` 对 sourceSet 全量线性扫描，update 同步删除阶段 O(N×D) | ✅ 采纳（收集阶段建 dirSet，O(1) 查询） |
| P-R2-2 | L | migrate.ts:47-54 | `filesEqual` 无条件整文件双读双哈希，未先做 size 快筛 | ✅ 采纳（stat size 前置） |
| P-R2-3 | L | forge.ts:601-605,297 | 一个构建周期 `package.json` 被读+parse 3 次 | ◻️ 评估后跳过（改签名破坏导出 API，收益小） |
| P-R2-4 | L | utils.ts:141-158 | `stdout += ` 逐 chunk 对字符串整体复制 | ✅ 采纳（与 B-R2-1 同改，Buffer[] + concat） |
| P-R2-5 | L | verify-load.ts:68 / hotmount.ts:55 | verify 与 mount 各以不同 tag import 同一 lib，短暂两个模块实例 | ◻️ 评估后跳过（一次性开销，内容稳定版本号不累积） |

### Maintenance（2 S / 4 M / 4 L）—— 主代理已将 S 级复核降级
| # | 严重度 | 位置 | 问题 | 主代理复核 |
|---|--------|------|------|------|
| M-R2-1 | ~~S~~→M | forge.ts:36-74, index.ts:24-77 | `ForgeConfig` interface、z-schema、`CONFIG_DEFAULTS` 三处声明 | ◻️ 复核后降级并跳过：schema 经 `z.default(CONFIG_DEFAULTS.x)` 单源默认值；做 `z.infer` 反转为大型重构，风险>收益 |
| M-R2-2 | ~~S~~→M | scripts/llm-e2e-host.mjs vs forge.ts:581-689 | 脚本整段复刻迁移核心且漂移（缺加载冒烟/profile 安装） | ◻️ 复核后降级并跳过：e2e-host 是"人工注入 startChild"的刻意等价路径，收敛为 CLI 单点属较大重构 |
| M-R2-3 | M | prompt.ts:114-119, forge.ts:197-213, integration.spec | REPORT 协议键三处自维护 | ◻️ 评估后跳过（低值，改动面广） |
| M-R2-4 | M | migrate.ts:8,57; forge.ts:361 | 排除集合重复 + `.pnpm-store` 第三处内联 | ✅ 采纳（抽 `.pnpm-store` 常量，`SYNC_PROTECTED` 由 `EXCLUDED` 派生） |
| M-R2-5 | M | index.spec/forge.integration.spec/llm-e2e-host | 配置默认值在 4 处 fixture 硬编码 | ◻️ 评估后跳过（收益小） |
| M-R2-6 | M | forge.ts:145 | `ForgeToolResult.build` 为宽 `string`，应是三值联合 | ✅ 采纳（`BuildStatus` 联合类型） |
| M-R2-7 | L | hotmount.ts:71-76, verify-load.ts:101-105 | Cordis 插件描述符构建两处重复 | ✅ 采纳（抽共用 `pluginDescriptor`） |
| M-R2-8 | L | utils.ts:269, migrate.ts:110,174, prompt | harness 目录名/标志在 4 模块硬编码 | ◻️ 评估后跳过（常量化收益小，改动面广） |
| M-R2-9 | L | forge.ts:654 | `slice(0,60)` 魔法数截断 summaryZh | ✅ 采纳（`SUMMARY_ZH_MAX` 命名） |
| M-R2-10 | L | index.ts:83 | `as Config` 断言掩盖 Partial 漂移 | ◻️ 评估后跳过（随 M-R2-1 一并解决才合理） |

### DeadCode（1 M / 4 L）—— 主体经 `noUnusedLocals` 已拦截，剩导出面无消费者的符号
| # | 严重度 | 位置 | 问题 | 处置 |
|---|--------|------|------|------|
| D-R2-1 | M | forge.ts:573,521 | `MigrateOptions.childText` 必填但函数体从不读取 | ✅ 采纳（删除字段+传参） |
| D-R2-2 | L | index.ts:128,139,140 | `runForge`/`mountPlugin`/`verifyPluginLoad` 无脚本/宿主消费者，与 index:95 策略矛盾 | ✅ 采纳澄清（注释标注为程序化契约，属有意保留） |
| D-R2-3 | L | index.ts:131-132 | `selfIterationSectionText`/`SELF_ITERATION_SECTION_ORDER` 纯冗余重复 re-export | ✅ 采纳（删除） |
| D-R2-4 | L | forge.ts:80,83 | `TEXT_TAIL`/`CHILD_TEXT_TAIL` 仅模块内使用却 `export` | ✅ 采纳（去 export） |
| D-R2-5 | L | forge.integration.spec.ts:45-56,152-162 | 夹具 REPORT 带旧协议字段（plugin_name/build/…），解析器已不消费 | ✅ 采纳（清理夹具） |

---

## 采纳修复汇总（提交中）

- `utils.ts`：`runCommand` 累积 `Buffer[]`，结束 `Buffer.concat(...).toString('utf8')` 一次解码（修 B-R2-1 + P-R2-4）；`filesEqual` 前置 `stat` size 快筛（修 P-R2-2）。
- `migrate.ts`：`syncRemoveStale` 收集阶段建 `dirSet`，移除 `hasSourcePrefix` 线性扫描（修 P-R2-1）；`rewriteCiHarnessPaths` 第二分支收紧 lookahead（修 B-R2-4）；抽 `.pnpm-store` 常量，`SYNC_PROTECTED_BASENAMES` 由 `EXCLUDED_BASENAMES` 派生（修 M-R2-4）。
- `forge.ts`：`runForge` 加 signal 守卫 `Promise.race` 兜底互斥释放（修 B-R2-2）；`verifyBuildInTarget` 收紧 main/types 存在性与包外逃逸（修 B-R2-3）；删 `MigrateOptions.childText`（修 D-R2-1）；`BuildStatus` 联合类型（修 M-R2-6）；`SUMMARY_ZH_MAX`（修 M-R2-9）；`TEXT_TAIL/CHILD_TEXT_TAIL` 去 export（修 D-R2-4）。抽 `pluginDescriptor` 到供 hotmount/verify-load 共用（修 M-R2-7）。
- `verify-load.ts`：改用共用 `pluginDescriptor`（修 M-R2-7）。
- `hotmount.ts`：改用共用 `pluginDescriptor`（修 M-R2-7）。
- `index.ts`：删 `selfIterationSectionText`/`SELF_ITERATION_SECTION_ORDER` 冗余 re-export（修 D-R2-3）；注释澄清 runForge/mountPlugin/verifyPluginLoad 为程序化契约保留（修 D-R2-2）。
- `forge.integration.spec.ts`：清理夹具中废弃 REPORT 字段（修 D-R2-5）。

> 注：M-R2-1 / M-R2-2 / M-R2-5 / M-R2-8 / M-R2-10 及部分 L 项按主代理复核评估为低收益或高重构风险，本轮不采纳，记录在案待后续按需处理。
