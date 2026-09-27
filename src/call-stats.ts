/**
 * 插件工具调用次数账本（self-iteration-forge 原生组件，宿主侧）。
 *
 * 账本文件：$DSH_HOME/storages/plugin-call-stats.json（缺省 ~/.dsh/storages/）。
 * 每个由 forge 创建/更新的插件在自己的 src/call-stats.ts 内联 plugin-call-stats.template.ts
 * 下发的标准模块，把自己的工具调用汇入同一个账本；本模块负责读取、汇总与渲染：
 *   - /self-iteration status：每个仓库一行追加「调用 N 次（成功 x / 失败 y），最近 …」
 *   - /self-iteration stats：按插件/工具出明细表（可按插件名过滤、可清零）
 *   - forge_capability 自身也用同一套接口记账（插件名 self-iteration-forge）
 *
 * 旁路原则：统计失败绝不影响 forge 流程——读账本失败按空账本处理，写失败只吞异常。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHome } from './utils.ts'

/** 账本文件名（与插件内联模块共享，勿改）。 */
export const CALL_STATS_FILE_NAME = 'plugin-call-stats.json'

/** 账本结构版本（与插件内联模块共享，勿改）。 */
export const CALL_STATS_VERSION = 1

/** 单个工具的调用统计。 */
export interface ToolCallStat {
  /** 累计调用次数。 */
  calls: number
  /** 成功次数。 */
  ok: number
  /** 失败次数。 */
  failed: number
  /** 最近一次调用时间（ISO 8601）。 */
  lastCalledAt: string
  /** 最近一次成功时间（ISO 8601）。 */
  lastOkAt?: string
  /** 最近一次失败时间（ISO 8601）。 */
  lastFailedAt?: string
  /** 最近一次失败的错误信息（截断）。 */
  lastError?: string
}

/** 一个插件的全部工具统计。 */
export interface PluginCallStat {
  /** 工具名 -> 统计。 */
  tools: Record<string, ToolCallStat>
  /** 首次记账时间（ISO 8601）。 */
  firstSeenAt: string
  /** 最近记账时间（ISO 8601）。 */
  updatedAt: string
}

/** 账本文件结构。 */
export interface CallStats {
  readonly version: number
  plugins: Record<string, PluginCallStat>
}

/** 插件维度的汇总数字（供 /self-iteration status 一行展示）。 */
export interface PluginCallTotals {
  calls: number
  ok: number
  failed: number
  tools: number
  lastCalledAt?: string
}

/** 账本绝对路径。 */
export function callStatsPath(): string {
  return path.join(dshHome(), 'storages', CALL_STATS_FILE_NAME)
}

/** 空账本。 */
export function emptyCallStats(): CallStats {
  return { version: CALL_STATS_VERSION, plugins: {} }
}

function isToolCallStat(value: unknown): value is ToolCallStat {
  if (typeof value !== 'object' || value === null) return false
  const stat = value as Partial<ToolCallStat>
  return typeof stat.calls === 'number' && typeof stat.ok === 'number' && typeof stat.failed === 'number'
}

function isPluginCallStat(value: unknown): value is PluginCallStat {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<PluginCallStat>
  if (typeof entry.tools !== 'object' || entry.tools === null) return false
  return Object.values(entry.tools).every(isToolCallStat)
}

/** 读取账本；文件缺失、损坏或结构非法时按空账本处理（不抛错）。 */
export async function loadCallStats(): Promise<CallStats> {
  let text: string
  try {
    text = await readFile(callStatsPath(), 'utf8')
  } catch {
    return emptyCallStats()
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return emptyCallStats()
    const raw = (parsed as { plugins?: unknown }).plugins
    if (typeof raw !== 'object' || raw === null) return emptyCallStats()
    const plugins: Record<string, PluginCallStat> = {}
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isPluginCallStat(value)) plugins[name] = value
    }
    return { version: CALL_STATS_VERSION, plugins }
  } catch {
    return emptyCallStats()
  }
}

/** 一次调用在账本里的增量（宿主侧记账用）。 */
interface Delta {
  calls: number
  ok: number
  failed: number
  lastCalledAt: string
  lastOkAt?: string
  lastFailedAt?: string
  lastError?: string
}

/** 待落盘增量：插件 -> 工具 -> 增量。 */
const pending = new Map<string, Map<string, Delta>>()

/** 落盘串行链：保证读-改-写不并发交错。 */
let chain: Promise<void> = Promise.resolve()

/** 合并当前批次增量并原子落盘。 */
async function flushOnce(): Promise<void> {
  if (pending.size === 0) return
  const batch = new Map(pending)
  pending.clear()
  const file = callStatsPath()
  const doc = await loadCallStats()
  const now = new Date().toISOString()
  for (const [plugin, tools] of batch) {
    const entry = doc.plugins[plugin] ?? { tools: {}, firstSeenAt: now, updatedAt: now }
    for (const [tool, delta] of tools) {
      const stat = entry.tools[tool] ?? {
        calls: 0,
        ok: 0,
        failed: 0,
        lastCalledAt: delta.lastCalledAt,
      }
      stat.calls += delta.calls
      stat.ok += delta.ok
      stat.failed += delta.failed
      stat.lastCalledAt = delta.lastCalledAt
      if (delta.lastOkAt !== undefined) stat.lastOkAt = delta.lastOkAt
      if (delta.lastFailedAt !== undefined) {
        stat.lastFailedAt = delta.lastFailedAt
        if (delta.lastError !== undefined) stat.lastError = delta.lastError
      }
      entry.tools[tool] = stat
    }
    entry.updatedAt = now
    doc.plugins[plugin] = entry
  }
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  } catch {
    // 统计是旁路：落盘失败只吞异常，不外泄。
  }
}

/**
 * 记一次工具调用（旁路，永不抛错、永不阻塞；调用方不需要 await）。
 * @param plugin - 插件名（kebab-case，与仓库目录名一致）。
 * @param tool - 工具名。
 * @param outcome - 调用结果。
 * @param error - 失败时的错误信息（截断后入库）。
 */
export function recordToolCall(
  plugin: string,
  tool: string,
  outcome: 'ok' | 'failed',
  error?: string,
): void {
  try {
    const at = new Date().toISOString()
    let tools = pending.get(plugin)
    if (tools === undefined) {
      tools = new Map<string, Delta>()
      pending.set(plugin, tools)
    }
    const stat = tools.get(tool) ?? { calls: 0, ok: 0, failed: 0, lastCalledAt: at }
    stat.calls += 1
    stat.lastCalledAt = at
    if (outcome === 'ok') {
      stat.ok += 1
      stat.lastOkAt = at
    } else {
      stat.failed += 1
      stat.lastFailedAt = at
      if (error !== undefined) stat.lastError = error.slice(0, 200)
    }
    tools.set(tool, stat)
    chain = chain.then(flushOnce).catch(() => undefined)
  } catch {
    // 统计是旁路：吞掉一切异常。
  }
}

/** 把待落盘增量立刻写盘（测试与优雅退出用；无待写内容时立即返回）。 */
export function flushCallStats(): Promise<void> {
  return chain
}

/** 汇总一个插件的全部工具；无记录时返回 undefined。 */
export function pluginCallTotals(stats: CallStats, plugin: string): PluginCallTotals | undefined {
  const entry = stats.plugins[plugin]
  if (entry === undefined) return undefined
  const totals: PluginCallTotals = { calls: 0, ok: 0, failed: 0, tools: 0 }
  for (const stat of Object.values(entry.tools)) {
    totals.calls += stat.calls
    totals.ok += stat.ok
    totals.failed += stat.failed
    totals.tools += 1
    if (totals.lastCalledAt === undefined || stat.lastCalledAt > totals.lastCalledAt) {
      totals.lastCalledAt = stat.lastCalledAt
    }
  }
  return totals
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '—'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString('zh-CN')
}

/** /self-iteration status 用的一行调用摘要；无记录时返回「尚无调用记录」。 */
export function formatPluginCallSummary(stats: CallStats, plugin: string): string {
  const totals = pluginCallTotals(stats, plugin)
  if (totals === undefined) return '尚无调用记录'
  return `调用 ${totals.calls} 次（成功 ${totals.ok} / 失败 ${totals.failed}，`
    + `共 ${totals.tools} 个工具），最近 ${formatTime(totals.lastCalledAt)}`
}

/** /self-iteration stats 的明细行（插件 -> 工具 -> 数字），按调用次数降序。 */
export function callStatRows(stats: CallStats, plugin?: string): string[] {
  const names = plugin === undefined
    ? Object.keys(stats.plugins).sort()
    : Object.prototype.hasOwnProperty.call(stats.plugins, plugin) ? [plugin] : []
  const rows: string[] = []
  for (const name of names) {
    const entry = stats.plugins[name]
    if (entry === undefined) continue
    const tools = Object.entries(entry.tools)
      .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    for (const [tool, stat] of tools) {
      rows.push(`| ${name} | ${tool} | ${stat.calls} | ${stat.ok} | ${stat.failed} | ${formatTime(stat.lastCalledAt)} |`)
    }
  }
  return rows
}

/** 清空账本（/self-iteration stats reset）；指定插件名时只清该插件，返回被清掉的工具条数。 */
export async function clearCallStats(plugin?: string): Promise<number> {
  if (plugin === undefined) {
    pending.clear()
    await rm(callStatsPath(), { force: true })
    return 0
  }
  pending.delete(plugin)
  const doc = await loadCallStats()
  const removed = Object.keys(doc.plugins[plugin]?.tools ?? {}).length
  delete doc.plugins[plugin]
  const file = callStatsPath()
  const tmp = `${file}.${process.pid}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return removed
}
