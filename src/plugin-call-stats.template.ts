/**
 * self-iteration-forge 下发的「插件工具调用次数」标准模块源码（模板）。
 *
 * 每个由 forge 创建/更新的插件，都在自己的 src/call-stats.ts 内联**逐字一致**的
 * 本模块源码（各插件是彼此独立的 git 仓库，不引入交叉依赖），并用它包裹每个工具的
 * execute，从而把调用次数汇入同一个账本：
 *
 *     execute: withCallStats('插件名', '工具名', async (args, exec) => { ... }),
 *
 * 账本文件与结构由 src/call-stats.ts（宿主侧）共享，/self-iteration status 与 /self-iteration stats
 * 直接读它做汇总；src/call-stats.spec.ts 校验两侧关键常量不漂移。
 *
 * 模板内的源码刻意不含反引号与 ${}（外层是模板字符串），换行用 \\n 转义，
 * 以保证子代理逐字复制后得到的文件是可编译的 TypeScript。
 */

/** 供子代理逐字复制到 <plugin>/src/call-stats.ts 的模块源码。 */
export const PLUGIN_CALL_STATS_SOURCE = `/**
 * 插件工具调用次数记录（self-iteration-forge 标准模块，勿改结构）。
 *
 * 与 self-iteration-forge 共用同一个账本：$DSH_HOME/storages/plugin-call-stats.json
 * （缺省 ~/.dsh/storages/），self-iteration-forge 的 /self-iteration status 与 /self-iteration stats
 * 读它汇总所有插件的调用次数、成功率与最近调用时间。
 *
 * 设计约束（改动前先想清楚）：
 * - 旁路统计：任何失败都不影响工具执行，recordCall 永不抛错、永不被 await 阻塞；
 * - 只记插件名 / 工具名 / 成败与时间，不记调用参数与返回值（不把用户数据写进账本）；
 * - 增量合并 + 原子写（tmp -> rename），同进程内的连续调用合并成一次落盘。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 账本文件名（与 self-iteration-forge 共享，勿改）。 */
export const STATS_FILE_NAME = 'plugin-call-stats.json'

/** 账本结构版本（与 self-iteration-forge 共享，勿改）。 */
export const STATS_VERSION = 1

/** 账本中保留的最后错误信息长度。 */
const ERROR_MAX = 200

/** DSH 数据目录：$DSH_HOME，缺省 ~/.dsh。 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

/** 账本绝对路径。 */
function statsPath(): string {
  return path.join(dshHome(), 'storages', STATS_FILE_NAME)
}

/** 一个工具在账本里的增量（尚未落盘）。 */
interface Delta {
  calls: number
  ok: number
  failed: number
  lastCalledAt: string
  lastOkAt?: string
  lastFailedAt?: string
  lastError?: string
}

/** 待落盘增量：插件 -> 工具 -> 增量，连续调用只累加，不各写一次。 */
const pending = new Map<string, Map<string, Delta>>()

/** 落盘串行链：保证读-改-写不并发交错。 */
let chain: Promise<void> = Promise.resolve()

/** 把当前批次增量合并进账本并原子落盘。 */
async function flushOnce(): Promise<void> {
  if (pending.size === 0) return
  const batch = new Map(pending)
  pending.clear()
  const file = statsPath()
  let doc: {
    version: number
    plugins: Record<string, {
      tools: Record<string, {
        calls: number
        ok: number
        failed: number
        lastCalledAt: string
        lastOkAt?: string
        lastFailedAt?: string
        lastError?: string
      }>
      firstSeenAt: string
      updatedAt: string
    }>
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('账本结构非法')
    doc = parsed as typeof doc
    if (typeof doc.plugins !== 'object' || doc.plugins === null) doc.plugins = {}
  } catch {
    // 账本不存在或已损坏：从空账本重建，保证工具执行不受影响。
    doc = { version: STATS_VERSION, plugins: {} }
  }
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
  await mkdir(path.dirname(file), { recursive: true })
  // 文件名带 pid：同机多个 DSH 进程各写各的 tmp，rename 仍是单次原子替换。
  const tmp = file + '.' + process.pid + '.tmp'
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\\n', 'utf8')
  await rename(tmp, file)
}

/**
 * 记一次工具调用（旁路，永不抛错、永不阻塞）。
 * @param plugin - 插件名（kebab-case，与仓库目录名一致）。
 * @param tool - 工具名（模型可见的下划线名）。
 * @param outcome - 本次调用的结果。
 * @param error - 失败时的错误信息（会被截断后存入账本）。
 */
export function recordCall(
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
      if (error !== undefined) stat.lastError = error.slice(0, ERROR_MAX)
    }
    tools.set(tool, stat)
    chain = chain.then(flushOnce).catch(() => undefined)
  } catch {
    // 统计是旁路：吞掉一切异常，绝不影响工具本身。
  }
}

/**
 * 包裹工具的 execute，自动记录调用次数与成败（失败时原样抛出，不吞错）。
 *
 * 用法：execute: withCallStats('插件名', '工具名', async (args, exec) => { ... })
 * @param plugin - 插件名。
 * @param tool - 工具名。
 * @param execute - 原 execute 实现。
 * @returns 与原 execute 同签名的异步函数。
 */
export function withCallStats<A extends unknown[], R>(
  plugin: string,
  tool: string,
  execute: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      const value = await execute(...args)
      recordCall(plugin, tool, 'ok')
      return value
    } catch (error) {
      recordCall(plugin, tool, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}
`
