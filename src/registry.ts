/** 插件登记表（$DSH_HOME/self-iteration-forge.json），原子写入。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHome, samePath } from './utils.ts'

/** 一个由本插件创建（或接管）的独立仓库。 */
export interface ForgeRepoEntry {
  /** kebab-case 插件名，同时是仓库目录名。 */
  readonly name: string
  /** 仓库绝对路径（正斜杠）。 */
  readonly path: string
  /** 首次创建时间（ISO 8601）。 */
  readonly createdAt: string
  /** 最近一次提交时间（ISO 8601）；尚无提交时缺省。 */
  readonly lastCommitAt?: string
  /** 累计提交次数。 */
  readonly commitCount: number
  /** 子代理 REPORT 的中文功能摘要（用于引导节"已有插件"清单，避免重复开发）。 */
  readonly summaryZh?: string
}

/** 登记表文件结构（version 便于日后迁移）。 */
export interface ForgeRegistry {
  readonly version: 1
  readonly repos: ForgeRepoEntry[]
}

const FILE_NAME = 'self-iteration-forge.json'

/** 更名前（2026-09-27 前为 dsh-plugin-forge）的登记表文件名，仅用于一次性迁移。 */
const LEGACY_FILE_NAME = 'plugin-forge.json'

function isEntry(value: unknown): value is ForgeRepoEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<ForgeRepoEntry>
  return typeof entry.name === 'string'
    && typeof entry.path === 'string'
    && typeof entry.createdAt === 'string'
    && (entry.lastCommitAt === undefined || typeof entry.lastCommitAt === 'string')
    && typeof entry.commitCount === 'number'
    && (entry.summaryZh === undefined || typeof entry.summaryZh === 'string')
}

/** 解析登记表文本；结构非法时抛错（不静默丢数据）。 */
function parseRegistry(text: string, fileName: string): ForgeRegistry {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${fileName} 顶层必须是对象`)
  const repos = (parsed as { repos?: unknown }).repos
  if (!Array.isArray(repos)) throw new Error(`${fileName} 缺少 repos 数组`)
  return { version: 1, repos: repos.filter(isEntry) }
}

/**
 * 读取登记表；新文件不存在时自动迁移更名前的 plugin-forge.json（读旧写新，保留全部条目）。
 * 两者都不存在时返回空表。
 */
export async function loadRegistry(): Promise<ForgeRegistry> {
  const file = path.join(dshHome(), FILE_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    const legacy = path.join(dshHome(), LEGACY_FILE_NAME)
    const legacyText = await readFile(legacy, 'utf8').catch(() => undefined)
    if (legacyText === undefined) return { version: 1, repos: [] }
    const migrated = parseRegistry(legacyText, LEGACY_FILE_NAME)
    // 迁移失败不应挡住 forge 流程：登记表丢失只影响 /self-iteration status 的展示。
    await saveRegistry(migrated).catch(() => undefined)
    return migrated
  }
  return parseRegistry(text, FILE_NAME)
}

/** 原子写入登记表。 */
export async function saveRegistry(registry: ForgeRegistry): Promise<void> {
  const dir = dshHome()
  const file = path.join(dir, FILE_NAME)
  const tmp = `${file}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 进程内 upsert 写锁链：串行化"读-改-写"，避免并发 forge 丢条目。 */
let upsertChain: Promise<unknown> = Promise.resolve()

/** 新增或更新一个仓库条目（按 path 匹配，Windows 下大小写不敏感），返回保存后的登记表。 */
export async function upsertRepo(entry: ForgeRepoEntry): Promise<ForgeRegistry> {
  const run = upsertChain.then(async () => {
    const registry = await loadRegistry()
    const index = registry.repos.findIndex((repo) => samePath(repo.path, entry.path))
    const repos = index >= 0
      ? registry.repos.map((repo, i) => (i === index ? entry : repo))
      : [...registry.repos, entry]
    const next: ForgeRegistry = { version: 1, repos }
    await saveRegistry(next)
    return next
  })
  // 链上任一失败不阻塞后续写入。
  upsertChain = run.catch(() => undefined)
  return run
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
