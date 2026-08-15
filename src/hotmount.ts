/** 运行时热挂载：动态 import 插件 lib 并 ctx.plugin 挂载（cache-busting；缺服务拒绝；失败不抛出）。 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { pathExists } from './migrate.ts'
import { BUILTIN_TOOL_NAMES } from './builtin-names.ts'

/** 热挂载结果（失败不抛出，detail 给用户可操作说明）。 */
export interface HotMountResult {
  readonly ok: boolean
  readonly detail?: string
}

/** 归一化插件的 inject 声明（string | string[] | Record → string[]；缺省 undefined）。 */
export function normalizeInject(inject: Plugin.Object['inject']): string[] | undefined {
  if (inject === undefined || inject === null) return undefined
  if (typeof inject === 'string') return [inject]
  if (Array.isArray(inject)) return inject
  return Object.keys(inject)
}

/**
 * 组装需被挂载/校验的 cordis 插件描述符（{ name, inject?, Config?, apply }）。
 * 热挂载与加载冒烟共用，避免两处重复展开对象字面量（M-R2-7）。
 */
export function pluginDescriptor(
  mod: { name?: string; inject?: Plugin.Object['inject']; Config?: Plugin.Object['Config'] },
  nameFallback: string,
  apply: Plugin.Object['apply'],
): Plugin.Object {
  return {
    name: mod.name ?? nameFallback,
    ...(mod.inject !== undefined ? { inject: mod.inject } : {}),
    ...(mod.Config !== undefined ? { Config: mod.Config } : {}),
    apply,
  }
}

/**
 * 动态加载已迁移插件的 lib/index.js（内容感知 cache-busting）。
 * 返回模块或失败原因（失败不抛出）。成功时 apply 已收窄为函数。
 *
 * 版本号用文件 mtimeMs+size 而非每次唯一后缀（B05/P01）：文件内容未变时
 * URL 保持不变 → 复用 ESM 模块缓存（不累积模块条目）；内容变化（如重新
 * 构建、update 迭代）时才生成新 URL → 强制加载新实例。
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
    const meta = await stat(libPath)
    // 内容感知版本：mtimeMs 毫秒级 + size 字节，内容变化必变。
    const version = `${meta.mtimeMs}-${meta.size}`
    const url = `${pathToFileURL(libPath).href}?${tag}=${version}`
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
    // 内置名冲突拦截：插件注册与 DSH 内置工具同名的工具时，跨 scope 注册
    // 不报错但模型侧遮蔽（真实事故：probe_echo）。包装 register 在挂载期拦截。
    const toolsService = ctx.get('tools') as { register?: (definition: unknown) => unknown } | undefined
    let originalRegister: ((definition: unknown) => unknown) | undefined
    if (toolsService !== undefined && typeof toolsService.register === 'function') {
      originalRegister = toolsService.register.bind(toolsService)
      toolsService.register = (definition: unknown) => {
        const name = (definition as { name?: unknown }).name
        if (typeof name === 'string' && BUILTIN_TOOL_NAMES.has(name)) {
          throw new TypeError(
            `tool "${name}" 与 DSH 内置工具同名：跨 scope 注册不会报错但模型侧会发生遮蔽（已阻止热挂载，请改名后 update=true 重试）`,
          )
        }
        return originalRegister!(definition)
      }
    }
    // 挂载并等待 fiber 完成：apply 的同步/异步错误在此被捕获，
    // 注入依赖的子 fiber（如 ctx.inject 快捷方式）也在 await 期间收敛。
    try {
      await ctx.plugin(pluginDescriptor(mod, path.basename(dir), mod.apply))
    } finally {
      if (toolsService !== undefined && originalRegister !== undefined) {
        toolsService.register = originalRegister
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
