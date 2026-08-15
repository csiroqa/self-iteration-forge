/**
 * 加载冒烟：构建通过不等于能加载。用真实 cordis Context + 复刻
 * dsh-commands/dsh-tools 加载校验的假服务执行插件 apply，拦截 apply 期
 * 错误（命令 input.hint 为空等，真实事故：session-notes 导致启动崩溃）。
 * commands/tools 用精确复刻校验；其余注入服务提供宽容占位（调用/访问
 * 不抛错），apply 照常执行——崩溃仍被拦截，不因服务不可复刻而跳过。
 *
 * 校验规则为 dsh-commands 的复刻（对照锚点：deepseek-harness
 * packages/interaction/commands/src/index.ts 的 normalizeDefinition，
 * 正则与错误消息需逐字一致）；harness 侧改动规则时需同步本文件，
 * 建议在 CI 中加一条"与 harness 规则一致性"对照测试。
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import path from 'node:path'
import { loadPluginLib, normalizeInject, pluginDescriptor } from './hotmount.ts'
import { BUILTIN_TOOL_NAMES } from './builtin-names.ts'

/** dsh-commands 的命令名校验（与 normalizeDefinition 一致）。 */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** 可被加载冒烟覆盖的服务名（其校验规则可精确复刻）。 */
const MOCKABLE_SERVICES = new Set(['commands', 'tools'])

/** 复刻 dsh-commands normalizeDefinition 的关键校验（注册期即崩溃点）。 */
function assertCommandDefinition(def: unknown): void {
  if (typeof def !== 'object' || def === null) {
    throw new TypeError('命令定义必须是对象')
  }
  const { name, description, input } = def as {
    name?: unknown
    description?: unknown
    input?: unknown
  }
  if (typeof name !== 'string' || !COMMAND_NAME.test(name)) {
    throw new TypeError(`command name "${String(name)}" must match ${String(COMMAND_NAME)}`)
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new TypeError(`command "${String(name)}" description must be a non-empty string`)
  }
  if (input !== undefined) {
    if (typeof input !== 'object' || input === null || typeof (input as { hint?: unknown }).hint !== 'string') {
      throw new TypeError(`command "${String(name)}" input hint must be a string`)
    }
    if ((input as { hint: string }).hint.trim().length === 0) {
      throw new TypeError(`command "${String(name)}" input hint must not be empty`)
    }
  }
}

/** 复刻 dsh-tools register 的关键校验（output 声明必需）。 */
function assertToolDefinition(def: unknown): void {
  if (typeof def !== 'object' || def === null) {
    throw new TypeError('工具定义必须是对象')
  }
  const { name, output } = def as { name?: unknown; output?: unknown }
  const out = output as { schema?: unknown; render?: unknown } | undefined
  if (out === undefined || typeof out !== 'object' || typeof out.render !== 'function') {
    throw new TypeError(`tool "${String(name)}" must declare output { schema, render }`)
  }
}

/**
 * 内置名冲突检查：插件工具名与 DSH 内置工具同名时，跨 scope 注册不报错
 * （dsh-tools 只拦截同 scope 重名）但模型侧遮蔽（真实事故：probe_echo）。
 * 在交付前拦截，阻止生成同名工具。
 */
function assertNoBuiltinConflict(def: unknown): void {
  if (typeof def !== 'object' || def === null) return
  const name = (def as { name?: unknown }).name
  if (typeof name === 'string' && BUILTIN_TOOL_NAMES.has(name)) {
    throw new TypeError(
      `tool "${name}" 与 DSH 内置工具同名：跨 scope 注册不会报错但模型侧会发生遮蔽（已阻止交付，请改名）`,
    )
  }
}

/**
 * 宽容占位服务：方法调用与属性访问均不抛错。
 * 用于无法精确复刻的注入服务（subagents/webServer/timer/…）——
 * 让 apply 照常执行以便捕捉崩溃。保守策略：apply 期即深度依赖
 * 服务返回值结构的插件会被拦截（真实环境下同样脆弱），提示后由
 * 子代理修复或人工复核，好过交付后启动崩溃。
 */
function lenientService(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined // 不当作 thenable：await 直接得到 undefined
      if (prop === Symbol.toPrimitive) return () => 0
      return lenientService()
    },
    apply: () => undefined,
  })
}

/** 加载冒烟结果（lib 缺失等构建层场景视为 skipped/ok）。 */
export interface VerifyLoadResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 对已迁移插件做加载冒烟；返回 ok=false 时该插件不应被交付/安装。 */
export async function verifyPluginLoad(dir: string): Promise<VerifyLoadResult> {
  const { mod, detail } = await loadPluginLib(dir, 'verify')
  if (mod === undefined) {
    // lib 缺失属于"未构建"，由构建层检查覆盖（保持原语义：skipped 视为 ok）。
    if (detail !== undefined && detail.includes('lib/index.js 不存在')) {
      return { ok: true, detail: 'skipped: lib/index.js 不存在' }
    }
    return { ok: false, detail: `模块加载失败：${detail ?? '未知错误'}` }
  }
  // commands/tools 精确复刻校验；其余注入服务提供宽容占位，
  // apply 照常执行，apply 期崩溃对所有 inject 组合都能拦截。
  const injectNames = normalizeInject(mod.inject)
  const ctx = new Context()
  ctx.provide('commands', {
    register: (def: unknown) => {
      assertCommandDefinition(def)
      return () => {}
    },
  })
  ctx.provide('tools', {
    register: (def: unknown) => {
      assertToolDefinition(def)
      assertNoBuiltinConflict(def)
      return () => {}
    },
  })
  for (const name of injectNames ?? []) {
    if (!MOCKABLE_SERVICES.has(name)) ctx.provide(name, lenientService())
  }

  let fiber: Fiber | undefined
  try {
    // mod.apply 已在上方收窄为 function；此处按 cordis Plugin.Object 契约断言。
    const apply = mod.apply as (ctx: Context) => unknown
    // M-R2-7：与热挂载共用 pluginDescriptor 组装描述符。
    fiber = await ctx.plugin(pluginDescriptor(mod, path.basename(dir), apply))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      detail: `apply 期错误：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    }
  } finally {
    // B01：释放冒烟用的临时 Context（事件发射器/fiber/服务条目等资源），
    // 防止长驻宿主多次 forge 交付时累积未回收的 Context。
    if (fiber !== undefined) await fiber.dispose().catch(() => undefined)
  }
}
