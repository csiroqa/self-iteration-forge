/** 运行时热挂载：动态 import 插件 lib 并 ctx.plugin 挂载（cache-busting；缺服务拒绝；失败不抛出）。 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { pathExists } from './migrate.ts'

/** 热挂载结果（失败不抛出，detail 给用户可操作说明）。 */
export interface HotMountResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 进程内单调自增序号：与时间戳组合成唯一 cache-bust 后缀（避免同毫秒命中 ESM 缓存）。 */
let mountSeq = 0

/** 归一化插件声明的 inject（字符串/数组/对象三种形态 → 服务名数组）。 */
export function normalizeInject(inject: unknown): string[] | undefined {
  if (inject === undefined || inject === null) return undefined
  if (typeof inject === 'string') return [inject]
  if (Array.isArray(inject)) return inject.filter((name): name is string => typeof name === 'string')
  if (typeof inject === 'object') return Object.keys(inject)
  return undefined
}

/**
 * 动态加载已迁移插件的 lib/index.js（cache-busting 保证更新后强制新实例）。
 * 返回模块或失败原因（失败不抛出）。成功时 apply 已收窄为函数。
 */
export async function loadPluginLib(
  dir: string,
  tag: string,
): Promise<{ mod?: Plugin.Object & { apply: NonNullable<Plugin.Object['apply']> }; detail?: string }> {
  const libPath = path.join(dir, 'lib', 'index.js')
  if (!(await pathExists(libPath))) {
    return { detail: `lib/index.js 不存在：${path.join(dir, 'lib')}` }
  }
  try {
    // cache-busting：同一路径反复 import 命中 ESM 缓存，更新后必须强制新实例。
    const url = `${pathToFileURL(libPath).href}?${tag}=${Date.now()}-${mountSeq++}`
    const mod = (await import(url)) as Partial<Plugin.Object>
    if (typeof mod.apply !== 'function') {
      return { detail: '模块缺少 apply 导出（不是有效的插件入口）' }
    }
    return { mod: mod as Plugin.Object & { apply: NonNullable<Plugin.Object['apply']> } }
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 动态挂载一个已迁移插件的 host 半区到当前运行时。 */
export async function mountPlugin(ctx: Context, dir: string): Promise<HotMountResult> {
  const { mod, detail } = await loadPluginLib(dir, 'forge')
  if (mod === undefined) return { ok: false, detail }
  try {
    // 注入可用性检查：当前运行时缺服务时拒绝挂载（等待会静默挂起）。
    const injectNames = normalizeInject(mod.inject)
    if (injectNames !== undefined && injectNames.length > 0) {
      const missing = injectNames.filter((service) => ctx.get(service) === undefined)
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `当前运行时缺少服务：${missing.join(', ')}。可改传 install: true 装入 profile，重启后生效。`,
        }
      }
    }
    // 挂载并等待 fiber 完成：apply 的同步/异步错误在此被捕获，
    // 注入依赖的子 fiber（如 ctx.inject 快捷方式）也在 await 期间收敛。
    await ctx.plugin({
      name: mod.name ?? path.basename(dir),
      ...(mod.inject !== undefined ? { inject: mod.inject } : {}),
      ...(mod.Config !== undefined ? { Config: mod.Config } : {}),
      apply: mod.apply,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
