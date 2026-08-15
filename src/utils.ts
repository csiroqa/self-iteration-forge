/** 通用工具函数（纯 Node，无外部依赖）：命令执行、命名、路径计算。 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

/** 一次外部命令的完整结果（无论退出码如何都返回，由调用方决定成败）。 */
export interface ExecResult {
  /** 进程退出码；-1 表示进程被信号终止或超时。 */
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 命令在进程级无法启动（ENOENT / EPERM / 超时等）时抛出。 */
export class SpawnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpawnError'
  }
}

/** 命令成功启动但退出码非零时，由 assertOk 抛出（不静默吞错）。 */
export class CommandFailedError extends Error {
  readonly result: ExecResult

  constructor(label: string, result: ExecResult) {
    super(`${label} 失败（exit=${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 2000)}`)
    this.name = 'CommandFailedError'
    this.result = result
  }
}

/**
 * Windows 下 pnpm/npm/dsh 是 .cmd 包装器，CreateProcess 无法直接执行
 * （execFile 会抛 EINVAL），必须经 cmd.exe 中转；/s 让 cmd 正确
 * 处理带引号的整条命令。其余可执行文件直接 spawn。
 */
function resolveSpawn(bin: string, args: readonly string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && (bin === 'pnpm' || bin === 'npm' || bin === 'npx' || bin === 'dsh')) {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `${bin}.cmd`, ...args] }
  }
  return { file: bin, args: [...args] }
}

/** 运行外部命令并完整捕获输出（host 半区代码，非沙箱 shell）。 */
export function runCommand(
  bin: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<ExecResult> {
  const { file, args: spawnArgs } = resolveSpawn(bin, args)
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      file,
      spawnArgs,
      {
        cwd: options.cwd,
        windowsHide: true,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof error.code === 'number' ? error.code : -1
        if (code === 0) {
          // 理论上不会走到这里；防御性处理。
          resolve({ code: 0, stdout, stderr })
          return
        }
        if (code === -1) {
          // 进程级失败（ENOENT / EPERM / 超时 / 信号）。
          reject(new SpawnError(`${bin} 无法启动或超时：${error.message}`))
          return
        }
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** 断言命令成功，否则抛出带输出的 CommandFailedError。 */
export async function assertOk(result: ExecResult, label: string): Promise<ExecResult> {
  if (result.code !== 0) throw new CommandFailedError(label, result)
  return result
}

/** kebab-case 安全命名：小写字母数字与连字符，不以连字符开头/结尾。 */
export function normalizePluginName(input: string | undefined, fallback: string): string {
  const raw = (input ?? '').trim().toLowerCase()
  const cleaned = raw
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

/** FNV-1a 32 位哈希（稳定、无依赖，用于生成确定性短后缀）。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 从需求文本生成缺省插件名（取前几个有意义的英文单词）。 */
export function slugFromRequirement(requirement: string): string {
  const words = requirement.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []
  const stop = new Set([
    'the', 'a', 'an', 'for', 'with', 'and', 'of', 'to', 'in', 'on', 'at', 'by',
    'plugin', 'dsh', 'make', 'create', 'build', 'add', 'need', 'want', 'please',
    '功能', '一个', '插件', '需要', '实现', '支持', '用于',
  ])
  const picked: string[] = []
  for (const word of words) {
    if (stop.has(word) || word.length <= 2) continue
    picked.push(word)
    if (picked.length >= 3) break
  }
  if (picked.length > 0) return picked.join('-')
  // 无有效英文词（如纯中文需求）时：用需求哈希做稳定后缀，
  // 避免多个中文需求全部落到同一个缺省名。
  return `dsh-plugin-${fnv1a(requirement).toString(16).padStart(8, '0')}`
}

/** 归一化路径用于比较（去尾斜杠、正斜杠）。 */
export function normalizePathForCompare(p: string): string {
  return toPosix(p).replace(/\/+$/g, '')
}

/**
 * 判断两个绝对路径是否指向同一位置。
 * Windows 下大小写不敏感（D:/2-OGP 与 d:/2-ogp 视为同一目录）。
 */
export function samePath(a: string, b: string): boolean {
  const na = normalizePathForCompare(a)
  const nb = normalizePathForCompare(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/** DSH 数据目录：$DSH_HOME，缺省 ~/.dsh。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

/** 计算从 fromDir 到 toDir 的相对路径（正斜杠，用于 link: 依赖）。 */
export function relativeLink(fromDir: string, toDir: string): string {
  return path.relative(fromDir, toDir).split(path.sep).join('/')
}

/** 路径分隔符统一为正斜杠（便于写入 JSON / 展示）。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** 从工作目录向上查找 deepseek-harness 检出根（含 vendor/cordis 者视为有效）。 */
export async function findHarnessRoot(startDir: string): Promise<string> {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, 'deepseek-harness')
    const marker = path.join(candidate, 'vendor', 'cordis')
    try {
      const { access } = await import('node:fs/promises')
      await access(marker)
      return candidate
    } catch {
      // 继续上溯。
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `找不到 deepseek-harness 检出（从 ${startDir} 向上 10 层内均无 vendor/cordis 标记）。`
    + ' 请在插件配置中设置 harnessRoot。',
  )
}

/**
 * 清洗子代理给出的英文摘要，使其适合作为 Conventional Commit 的
 * 主题一部分：只保留可打印 ASCII、空白折叠、按字符数截断。
 */
export function cleanSummaryEn(input: string | undefined): string {
  if (input === undefined) return ''
  return input
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
}

/**
 * 组装英文 Conventional Commit 主题（header ≤ 72 字符）：
 * `<type>: <name>[: <summary>]`。summary 过长时按剩余预算截断。
 */
export function buildCommitSubject(
  commitType: string,
  name: string,
  summaryEn: string | undefined,
): string {
  const type = /^[a-z][a-z0-9-]*$/.test(commitType) ? commitType : 'feat'
  const summary = cleanSummaryEn(summaryEn)
  if (summary === '') return `${type}: ${name}`
  const prefix = `${type}: ${name}: `
  const budget = 72 - prefix.length
  const clipped = budget > 0 ? summary.slice(0, budget) : ''
  return clipped === '' ? `${type}: ${name}` : `${prefix}${clipped}`
}
