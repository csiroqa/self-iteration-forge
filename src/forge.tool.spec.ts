/**
 * 工具注册（主名 + 过渡期别名）的测试。
 *
 * 覆盖：
 *  1. 主名 extend_self 与别名 add_capability 都在册，旧名 forge_capability 已下线；
 *  2. 两个名字指向同一套参数与行为（别名只是多一个入口，不是多一份实现）；
 *  3. 撤销函数按注册的逆序把两个注册都撤掉；
 *  4. 账本按「实际被调用的名字」分记——别名仍在用时要在 stats 里看得见。
 *
 * 每个用例把 DSH_HOME 指向独立临时目录，不碰真实账本。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { flushCallStats, loadCallStats } from './call-stats.ts'
import { registerForgeTool } from './forge.ts'

const PRIMARY = 'extend_self'
const ALIAS = 'add_capability'
const RETIRED = 'forge_capability'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'forge-tool-name-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('registerForgeTool', () => {
  it('同时注册主名与过渡期别名，旧名不再注册', () => {
    const names: string[] = []
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (d: { name: string }) => { names.push(d.name); return () => {} } },
    } as unknown as Context

    const dispose = registerForgeTool(ctx, {} as never)
    expect(typeof dispose).toBe('function')
    expect(names).toEqual([PRIMARY, ALIAS])
    expect(names).not.toContain(RETIRED)
  })

  it('别名与主名共享同一套参数，且描述里点明主名', () => {
    const defs = new Map<string, { description: string; parameters: unknown }>()
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: {
        register: (d: { name: string; description: string; parameters: unknown }) => {
          defs.set(d.name, d)
          return () => {}
        },
      },
    } as unknown as Context

    registerForgeTool(ctx, {} as never)
    const primary = defs.get(PRIMARY)
    const alias = defs.get(ALIAS)
    expect(primary).toBeDefined()
    expect(alias).toBeDefined()
    // 参数 schema 内容一致（defineTool 每次会包一层，所以比 JSON 而不是引用）。
    expect(JSON.stringify(alias?.parameters)).toBe(JSON.stringify(primary?.parameters))
    // 别名描述自带引导，避免模型优先挑别名。
    expect(alias?.description).toContain(`别名`)
    expect(alias?.description).toContain(PRIMARY)
    // 主名描述不带别名前缀，保持干净。
    expect(primary?.description).not.toContain('别名')
  })

  it('撤销函数把两个注册都撤掉，且按逆序', () => {
    const undone: string[] = []
    const names: string[] = []
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: {
        register: (d: { name: string }) => {
          names.push(d.name)
          return () => { undone.push(d.name) }
        },
      },
    } as unknown as Context

    const dispose = registerForgeTool(ctx, {} as never)
    dispose()
    expect(undone).toEqual([ALIAS, PRIMARY])
  })
})

describe('账本按实际调用名分记', () => {
  it('别名被调用时记在别名名下，主名调用记在主名下', async () => {
    const defs = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: {
        register: (d: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
          defs.set(d.name, d)
          return () => {}
        },
      },
    } as unknown as Context
    registerForgeTool(ctx, {} as never)

    // 让子代理启动立刻抛错：execute 必走 finally 记账，不碰网络与磁盘之外的副作用。
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'test', name: 'test', model: 'test' },
      startSubagent: () => { throw new Error('probe: 子代理不可用') },
    }
    for (const toolName of [PRIMARY, ALIAS]) {
      await defs.get(toolName)?.execute({ requirement: 'probe' }, exec).catch(() => {})
    }
    await flushCallStats()

    const ledger = await loadCallStats()
    const keys = Object.keys(ledger.plugins)
    expect(keys).toContain('self-iteration-forge')
    const tools = ledger.plugins['self-iteration-forge']?.tools ?? {}
    expect(tools[PRIMARY]?.calls).toBe(1)
    expect(tools[PRIMARY]?.failed).toBe(1)
    expect(tools[ALIAS]?.calls).toBe(1)
    expect(tools[ALIAS]?.failed).toBe(1)
    expect(tools[RETIRED]).toBeUndefined()
  })
})
