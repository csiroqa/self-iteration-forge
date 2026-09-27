/**
 * self-iteration-forge —— 热挂载测试（真实 @deepseek-ai/cordis Context）。
 *
 * 验证 mountPlugin：
 *  - 缺服务时拒绝并给出重启方案；
 *  - 服务齐备时挂载成功，插件 apply 的注册回调被执行；
 *  - cache-busting：更新插件后再次挂载会加载新实例。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountPlugin } from './hotmount.ts'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'self-iteration-forge-hotmount-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** 生成一个极简插件 lib/index.js（模拟已构建的 host 半区）。 */
async function writeFixture(dir: string, opts: { name: string; inject?: string[]; fail?: boolean; toolName?: string }): Promise<string> {
  const libDir = path.join(dir, 'lib')
  await mkdir(libDir, { recursive: true })
  const injectJson = JSON.stringify(opts.inject ?? ['commands'])
  const body = opts.fail
    ? 'export const name = "boom"\nexport function apply() { throw new Error("apply 爆炸") }\n'
    : [
        `export const name = ${JSON.stringify(opts.name)}`,
        `export const inject = ${injectJson}`,
        'export function apply(ctx) {',
        '  // inject 已由插件声明提供，apply 可直接访问 ctx.commands。',
        ...(opts.toolName !== undefined
          ? [
              '  ctx.tools.register({',
              `    name: ${JSON.stringify(opts.toolName)},`,
              '    description: "demo",',
              '    output: { schema: { type: "object", properties: {} }, render: () => [] },',
              '    execute: async () => ({}),',
              '  })',
            ]
          : ['  ctx.commands.register({ name: "hi", description: "hi", handler: () => ({ kind: "success", text: "hi" }) })']),
        '}',
        '',
      ].join('\n')
  await writeFile(path.join(libDir, 'index.js'), body, 'utf8')
  return libDir
}

describe('mountPlugin（真实 cordis Context）', () => {
  it('缺服务时拒绝挂载并给出重启方案', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'hot-demo', inject: ['missing-service'] })
    const ctx = new Context()
    const result = await mountPlugin(ctx, path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('missing-service')
    expect(result.detail).toContain('install: true')
  })

  it('服务齐备时挂载成功，插件的注册回调被执行', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'hot-demo', inject: ['commands'] })
    const ctx = new Context()
    const registered: string[] = []
    // 提供假 commands 服务（模拟 base bundle 里的 dsh-commands）。
    ctx.provide('commands', {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => {}
      },
    })
    const result = await mountPlugin(ctx, path.dirname(libDir))
    expect(result.ok).toBe(true)
    expect(registered).toContain('hi')
  })

  it('cache-busting：更新插件后再次挂载加载新实例', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'hot-demo-v1', inject: ['commands'] })
    const ctx = new Context()
    const mounted: string[] = []
    const originalPlugin = ctx.plugin.bind(ctx)
    // 记录每次挂载的插件名，同时保留真实挂载行为。
    ctx.plugin = ((plugin: unknown) => {
      mounted.push((plugin as { name?: string }).name ?? '?')
      return originalPlugin(plugin as Parameters<typeof ctx.plugin>[0])
    }) as typeof ctx.plugin
    ctx.provide('commands', { register: () => () => {} })

    const first = await mountPlugin(ctx, path.dirname(libDir))
    expect(first.ok).toBe(true)
    expect(mounted).toEqual(['hot-demo-v1'])

    // 覆盖 lib 后再次挂载：应加载新模块实例（v2）。
    await writeFixture(tempRoot, { name: 'hot-demo-v2', inject: ['commands'] })
    const second = await mountPlugin(ctx, path.dirname(libDir))
    expect(second.ok).toBe(true)
    expect(mounted).toEqual(['hot-demo-v1', 'hot-demo-v2'])
  })

  it('apply 抛错时返回失败详情而非抛出', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'boom', inject: ['commands'], fail: true })
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} })
    const result = await mountPlugin(ctx, path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('apply 爆炸')
  })

  it('注册与宿主已有工具同名的工具被拒绝（read 为真实内置工具）', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'shadow', inject: ['tools'], toolName: 'read' })
    const ctx = new Context()
    ctx.provide('tools', { register: () => () => {} })
    const result = await mountPlugin(ctx, path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('read')
    expect(result.detail).toContain('遮蔽')
  })

  it('非内置同名工具正常挂载', async () => {
    const libDir = await writeFixture(tempRoot, { name: 'fresh', inject: ['tools'], toolName: 'fresh_tool_name' })
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => {}
      },
    })
    const result = await mountPlugin(ctx, path.dirname(libDir))
    expect(result.ok).toBe(true)
    expect(registered).toEqual(['fresh_tool_name'])
  })
})
