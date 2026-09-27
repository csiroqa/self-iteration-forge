/**
 * 工具调用次数账本与 /forge 子命令解析的测试。
 *
 * 覆盖三条主线：
 *  1. 模板与宿主不漂移（下发给插件的源码必须与宿主读写的账本结构一致）；
 *  2. 记账 -> 落盘 -> 读取 -> 汇总的闭环（含并发累加与旁路容错）；
 *  3. /forge 子命令解析（status / stats / stats reset）。
 *
 * 每个用例把 DSH_HOME 指向独立临时目录，互不干扰真实账本。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CALL_STATS_FILE_NAME,
  CALL_STATS_VERSION,
  callStatRows,
  callStatsPath,
  clearCallStats,
  emptyCallStats,
  flushCallStats,
  formatPluginCallSummary,
  loadCallStats,
  pluginCallTotals,
  recordToolCall,
} from './call-stats.ts'
import { parseForgeSubcommand } from './forge.ts'
import { PLUGIN_CALL_STATS_SOURCE } from './plugin-call-stats.template.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'forge-call-stats-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('模板与宿主的一致性', () => {
  it('账本文件名与结构版本两侧一致', () => {
    expect(PLUGIN_CALL_STATS_SOURCE).toContain(`STATS_FILE_NAME = '${CALL_STATS_FILE_NAME}'`)
    expect(PLUGIN_CALL_STATS_SOURCE).toContain(`STATS_VERSION = ${CALL_STATS_VERSION}`)
  })

  it('模板暴露记账与包裹两个入口，且路径落在 storages 下', () => {
    expect(PLUGIN_CALL_STATS_SOURCE).toContain('export function recordCall(')
    expect(PLUGIN_CALL_STATS_SOURCE).toContain('export function withCallStats<')
    expect(PLUGIN_CALL_STATS_SOURCE).toContain("path.join(dshHome(), 'storages', STATS_FILE_NAME)")
  })

  it('模板源码可安全嵌入外层模板字符串（无反引号与未转义的 ${）', () => {
    expect(PLUGIN_CALL_STATS_SOURCE).not.toContain('`')
    expect(PLUGIN_CALL_STATS_SOURCE).not.toContain('${')
    // 换行必须以转义形式存在：解出来的源码里是字面量 \n，而不是真的换行。
    expect(PLUGIN_CALL_STATS_SOURCE).toContain("\\n'")
  })
})

describe('记账闭环', () => {
  it('账本不存在时按空账本处理，不抛错', async () => {
    const stats = await loadCallStats()
    expect(stats).toEqual(emptyCallStats())
    expect(formatPluginCallSummary(stats, 'hotclean-ping')).toBe('尚无调用记录')
  })

  it('记录成功与失败后能读回并汇总', async () => {
    recordToolCall('hotclean-ping', 'hotclean_ping', 'ok')
    recordToolCall('hotclean-ping', 'hotclean_ping', 'failed', 'boom')
    await flushCallStats()

    const stats = await loadCallStats()
    const stat = stats.plugins['hotclean-ping']?.tools.hotclean_ping
    expect(stat?.calls).toBe(2)
    expect(stat?.ok).toBe(1)
    expect(stat?.failed).toBe(1)
    expect(stat?.lastError).toBe('boom')
    expect(stat?.lastOkAt).toBeTruthy()
    expect(stat?.lastFailedAt).toBeTruthy()

    const totals = pluginCallTotals(stats, 'hotclean-ping')
    expect(totals).toMatchObject({ calls: 2, ok: 1, failed: 1, tools: 1 })
    expect(formatPluginCallSummary(stats, 'hotclean-ping')).toContain('调用 2 次（成功 1 / 失败 1')
  })

  it('多次调用累加到同一行而不是互相覆盖', async () => {
    for (let i = 0; i < 5; i += 1) recordToolCall('a', 't', 'ok')
    await flushCallStats()
    const stats = await loadCallStats()
    expect(stats.plugins.a?.tools.t?.calls).toBe(5)
  })

  it('不同插件的工具互不干扰', async () => {
    recordToolCall('a', 't', 'ok')
    recordToolCall('b', 't', 'ok')
    recordToolCall('b', 'u', 'ok')
    await flushCallStats()
    const stats = await loadCallStats()
    expect(Object.keys(stats.plugins).sort()).toEqual(['a', 'b'])
    expect(pluginCallTotals(stats, 'b')).toMatchObject({ calls: 2, tools: 2 })
  })

  it('明细行按调用次数降序', async () => {
    recordToolCall('a', 'rare', 'ok')
    recordToolCall('a', 'hot', 'ok')
    recordToolCall('a', 'hot', 'ok')
    await flushCallStats()
    const stats = await loadCallStats()
    const rows = callStatRows(stats, 'a')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('| a | hot | 2 |')
    expect(rows[1]).toContain('| a | rare | 1 |')
  })

  it('账本文件写在 $DSH_HOME/storages 下，结构可被再次读取', async () => {
    recordToolCall('a', 't', 'ok')
    await flushCallStats()
    expect(callStatsPath()).toBe(path.join(home, 'storages', CALL_STATS_FILE_NAME))
    const raw: unknown = JSON.parse(await readFile(callStatsPath(), 'utf8'))
    expect(raw).toMatchObject({ version: CALL_STATS_VERSION })
  })

  it('账本损坏时按空账本处理，不抛错', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(path.join(home, 'storages'), { recursive: true })
    await writeFile(callStatsPath(), '{ 这不是 JSON', 'utf8')
    await expect(loadCallStats()).resolves.toEqual(emptyCallStats())
  })

  it('reset 清空全部或单个插件', async () => {
    recordToolCall('a', 't', 'ok')
    recordToolCall('b', 't', 'ok')
    await flushCallStats()
    expect(await clearCallStats('a')).toBe(1)
    const afterOne = await loadCallStats()
    expect(Object.keys(afterOne.plugins)).toEqual(['b'])
    await clearCallStats()
    expect(await loadCallStats()).toEqual(emptyCallStats())
  })
})

describe('/forge 子命令解析', () => {
  it('空输入与 status 都走 status', () => {
    expect(parseForgeSubcommand('')).toEqual({ kind: 'status' })
    expect(parseForgeSubcommand('   ')).toEqual({ kind: 'status' })
    expect(parseForgeSubcommand('status')).toEqual({ kind: 'status' })
  })

  it('未知子命令按 status 处理（保持裸 /self-iteration 的旧行为）', () => {
    expect(parseForgeSubcommand('wat')).toEqual({ kind: 'status' })
  })

  it('stats 支持可选插件名与 reset', () => {
    expect(parseForgeSubcommand('stats')).toEqual({ kind: 'stats', reset: false })
    expect(parseForgeSubcommand('stats opencode-go-session'))
      .toEqual({ kind: 'stats', plugin: 'opencode-go-session', reset: false })
    expect(parseForgeSubcommand('stats reset')).toEqual({ kind: 'stats', reset: true })
    expect(parseForgeSubcommand('stats reset opencode-go-session'))
      .toEqual({ kind: 'stats', plugin: 'opencode-go-session', reset: true })
  })
})
