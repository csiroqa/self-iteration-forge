/**
 * plugin-forge —— 加载冒烟测试。
 *
 * 用真实 cordis Context + 假 commands/tools 服务执行插件 apply，
 * 验证 apply 期错误（命令 input.hint 为空、description 为空、工具缺 output）
 * 能被 verifyPluginLoad 捕获——这正是"构建通过但 DSH 启动即崩"的拦截层。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPluginLoad } from './verify-load.ts'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plugin-forge-verifyload-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** 生成一个插件 lib/index.js；opts 控制 apply 内的注册行为。 */
async function writePlugin(
  dir: string,
  opts: {
    name?: string
    inject?: string[]
    /** apply 主体（原始 JS，注入到函数体内）。 */
    body: string
  },
): Promise<string> {
  const libDir = path.join(dir, 'lib')
  await mkdir(libDir, { recursive: true })
  const injectJson = JSON.stringify(opts.inject ?? [])
  const content = [
    `export const name = ${JSON.stringify(opts.name ?? 'verify-demo')}`,
    `export const inject = ${injectJson}`,
    'export function apply(ctx) {',
    opts.body,
    '}',
    '',
  ].join('\n')
  await writeFile(path.join(libDir, 'index.js'), content, 'utf8')
  return libDir
}

describe('verifyPluginLoad（加载冒烟）', () => {
  it('捕获命令 input.hint 为空（session-notes 事故同款）', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['commands'],
      body: [
        '  ctx.commands.register({',
        "    name: 'notes-status',",
        "    description: 'status',",
        "    input: { hint: '' },",
        '    handler: () => ({ kind: "success", text: "ok" }),',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('input hint must not be empty')
  })

  it('捕获命令 description 为空', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['commands'],
      body: [
        '  ctx.commands.register({',
        "    name: 'notes-status',",
        "    description: '  ',",
        '    handler: () => ({ kind: "success", text: "ok" }),',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('description must be a non-empty string')
  })

  it('捕获工具缺 output 声明', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['tools'],
      body: [
        '  ctx.tools.register({',
        "    name: 'demo-tool',",
        "    description: 'demo',",
        '    execute: async () => "ok",',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('must declare output')
  })

  it('合法命令插件通过', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['commands'],
      body: [
        '  ctx.commands.register({',
        "    name: 'notes-status',",
        "    description: 'status',",
        "    input: { hint: 'status' },",
        '    handler: () => ({ kind: "success", text: "ok" }),',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(true)
  })

  it('注入无法复刻的服务时跳过（skipped 视为通过）', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['subagents'],
      body: '  void ctx',
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('skipped')
  })

  it('apply 抛错被捕获并返回结构化详情', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: [],
      body: '  throw new Error("apply 阶段爆炸")',
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('apply 期错误')
    expect(result.detail).toContain('apply 阶段爆炸')
  })
})
