/**
 * self-iteration-forge —— 加载冒烟测试。
 *
 * 用真实 cordis Context + 假 commands/tools 服务执行插件 apply，
 * 验证 apply 期错误（命令 input.hint 为空、description 为空、工具缺 output）
 * 能被 verifyPluginLoad 捕获——这正是"构建通过但 DSH 启动即崩"的拦截层。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPluginLoad } from './verify-load.ts'
import { findHarnessRoot } from './utils.ts'

/** 仓库根（本文件在 src/ 下）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'self-iteration-forge-verifyload-'))
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

  it('拦截与宿主已有工具同名的注册（read 为真实内置工具）', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['tools'],
      body: [
        '  ctx.tools.register({',
        "    name: 'read',",
        "    description: 'demo',",
        '    output: { schema: { type: "object", properties: {} }, render: () => [] },',
        '    execute: async () => ({}),',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('read')
    expect(result.detail).toContain('遮蔽')
  })

  it('同名工具改名后通过', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['tools'],
      body: [
        '  ctx.tools.register({',
        "    name: 'unique_tool_name',",
        "    description: 'demo',",
        '    output: { schema: { type: "object", properties: {} }, render: () => [] },',
        '    execute: async () => ({}),',
        '  })',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(true)
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

  it('注入不可复刻的服务时提供宽容占位，合法 apply 通过', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['subagents', 'webServer'],
      body: '  void ctx',
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(true)
  })

  it('注入不可复刻的服务时 apply 崩溃仍被拦截（不再跳过）', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['subagents'],
      body: '  throw new Error("apply 阶段爆炸")',
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('apply 期错误')
    expect(result.detail).toContain('apply 阶段爆炸')
  })

  it('宽容占位下调用注入服务方法不抛错，apply 正常完成', async () => {
    const libDir = await writePlugin(tempRoot, {
      inject: ['subagents'],
      body: [
        '  const provider = ctx.subagents.getProvider("spawn")',
        '  ctx.subagents.start("spawn", { label: "x", prompt: [] })',
        '  void provider',
      ].join('\n'),
    })
    const result = await verifyPluginLoad(path.dirname(libDir))
    expect(result.ok).toBe(true)
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

describe('harness 复刻规则一致性（M06）', () => {
  it('COMMAND_NAME 正则与 deepseek-harness 真身逐字一致', async () => {
    const harnessRoot = await findHarnessRoot(process.cwd())
    const src = await readFile(
      path.join(harnessRoot, 'packages', 'interaction', 'commands', 'src', 'index.ts'),
      'utf8',
    )
    // 提取真身 COMMAND_NAME 正则字面量，与本地复刻比对。
    const truth = src.match(/const COMMAND_NAME = (\S+)/)?.[1]
    expect(truth).toBeDefined()
    // 本地复刻：verify-load.ts 的 COMMAND_NAME 行。
    const local = (await readFile(path.join(REPO_ROOT, 'src', 'verify-load.ts'), 'utf8'))
      .match(/const COMMAND_NAME = (\S+)/)?.[1]
    expect(local).toBe(truth)
  })

  it('hint/description 错误消息与真身一致（放行/拦截口径不漂移）', async () => {
    const harnessRoot = await findHarnessRoot(process.cwd())
    const src = await readFile(
      path.join(harnessRoot, 'packages', 'interaction', 'commands', 'src', 'index.ts'),
      'utf8',
    )
    const truthHint = src.match(/input hint must be a string/) !== null
    const truthEmpty = src.match(/input hint must not be empty/) !== null
    const local = await readFile(path.join(REPO_ROOT, 'src', 'verify-load.ts'), 'utf8')
    expect(truthHint).toBe(true)
    expect(truthEmpty).toBe(true)
    expect(local).toContain('input hint must be a string')
    expect(local).toContain('input hint must not be empty')
  })
})
