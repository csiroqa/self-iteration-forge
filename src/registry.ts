/**
 * plugin-forge —— 锻造仓库登记表。
 *
 * 持久化在 $DSH_HOME/plugin-forge.json，记录本插件创建的独立仓库，
 * 供 /forge status 查询与后续更新流程复用。原子写入（tmp + rename），
 * 崩溃不会留下半截文件。
 */
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
  /** 子代理 REPORT 的中文功能摘要（用于引导节"已有插件"清单，避免重复造轮子）。 */
  readonly summaryZh?: string
}

/** 登记表文件结构（version 便于日后迁移）。 */
export interface ForgeRegistry {
  readonly version: 1
  readonly repos: ForgeRepoEntry[]
}

const FILE_NAME = 'plugin-forge.json'

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

/** 读取登记表；文件不存在时返回空表。 */
export async function loadRegistry(): Promise<ForgeRegistry> {
  const file = path.join(dshHome(), FILE_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, repos: [] }
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('plugin-forge.json 顶层必须是对象')
  const repos = (parsed as { repos?: unknown }).repos
  if (!Array.isArray(repos)) throw new Error('plugin-forge.json 缺少 repos 数组')
  return { version: 1, repos: repos.filter(isEntry) }
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

/** 新增或更新一个仓库条目（按 path 匹配，Windows 下大小写不敏感），返回保存后的登记表。 */
export async function upsertRepo(entry: ForgeRepoEntry): Promise<ForgeRegistry> {
  const registry = await loadRegistry()
  const index = registry.repos.findIndex((repo) => samePath(repo.path, entry.path))
  const repos = index >= 0
    ? registry.repos.map((repo, i) => (i === index ? entry : repo))
    : [...registry.repos, entry]
  const next: ForgeRegistry = { version: 1, repos }
  await saveRegistry(next)
  return next
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
