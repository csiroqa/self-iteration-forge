/**
 * 加载冒烟：构建通过不等于能加载。用真实 cordis Context + 复刻
 * dsh-commands/dsh-tools 加载校验的假服务执行插件 apply，拦截 apply 期
 * 错误（命令 input.hint 为空等，真实事故：session-notes 导致启动崩溃）。
 * 仅覆盖 inject ⊆ {commands, tools} 的插件；其他跳过（由构建检查补充）。
 */
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { pathExists } from './migrate.ts'

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

/** 加载冒烟结果（skipped 视为 ok，由构建检查补充）。 */
export interface VerifyLoadResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 对已迁移插件做加载冒烟；返回 ok=false 时该插件不应被交付/安装。 */
export async function verifyPluginLoad(dir: string): Promise<VerifyLoadResult> {
  const libPath = path.join(dir, 'lib', 'index.js')
  if (!(await pathExists(libPath))) {
    return { ok: true, detail: 'skipped: lib/index.js 不存在' }
  }
  let mod: { name?: string; inject?: string[] | Record<string, unknown>; apply?: unknown }
  try {
    // cache-busting：避免模块缓存导致重复校验拿到旧实例。
    const url = `${pathToFileURL(libPath).href}?verify=${Date.now()}`
    mod = (await import(url)) as typeof mod
  } catch (error) {
    return { ok: false, detail: `模块加载失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof mod.apply !== 'function') {
    return { ok: false, detail: '模块缺少 apply 导出（不是有效的插件入口）' }
  }
  // 只覆盖 inject ⊆ {commands, tools} 的插件；其他服务无法精确复刻，跳过。
  const injectNames = Array.isArray(mod.inject) ? mod.inject : Object.keys(mod.inject ?? {})
  const unmockable = injectNames.filter((name) => !MOCKABLE_SERVICES.has(name))
  if (unmockable.length > 0) {
    return { ok: true, detail: `skipped: 注入服务无法复刻（${unmockable.join(', ')}）` }
  }

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
      return () => {}
    },
  })

  try {
    // mod.apply 已在上方收窄为 function；此处按 cordis Plugin.Object 契约断言。
    const apply = mod.apply as (ctx: Context) => unknown
    await ctx.plugin({
      name: mod.name ?? path.basename(dir),
      ...(mod.inject !== undefined ? { inject: mod.inject } : {}),
      apply,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      detail: `apply 期错误：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    }
  }
}
