/**
 * plugin-forge —— 运行时热挂载（子代理交付后的"无缝切换"）。
 *
 * 把新插件的 lib/index.js 动态 import 并挂载到当前 cordis 运行时
 * （ctx.plugin），使当前会话立即获得新工具/命令，无需重启 dsh web。
 *
 * 约束与降级：
 *  - 只挂载 inject 服务当前运行时可用的插件（缺服务则拒绝并给出重启方案）；
 *  - 动态 import 带 cache-busting query（同一路径反复 import 会命中 ESM
 *    缓存，更新后必须强制加载新实例）；
 *  - 任何失败都返回结构化结果而非抛出，宿主主流程不受影响。
 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { pathExists } from './migrate.ts'

/** 热挂载结果（失败不抛出，detail 给用户可操作说明）。 */
export interface HotMountResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 动态挂载一个已迁移插件的 host 半区到当前运行时。 */
export async function mountPlugin(ctx: Context, dir: string): Promise<HotMountResult> {
  const libPath = path.join(dir, 'lib', 'index.js')
  if (!(await pathExists(libPath))) {
    return { ok: false, detail: `lib/index.js 不存在：${path.join(dir, 'lib')}` }
  }
  try {
    // cache-busting：同一路径反复 import 命中 ESM 缓存，更新后必须强制新实例。
    const url = `${pathToFileURL(libPath).href}?forge=${Date.now()}`
    const mod = (await import(url)) as Partial<Plugin.Object>
    if (typeof mod.apply !== 'function') {
      return { ok: false, detail: '模块缺少 apply 导出（不是有效的插件入口）' }
    }
    // 注入可用性检查：当前运行时缺服务时拒绝挂载（等待会静默挂起）。
    if (mod.inject !== undefined) {
      const names = Array.isArray(mod.inject) ? mod.inject : Object.keys(mod.inject)
      const missing = names.filter((service) => ctx.get(service) === undefined)
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
