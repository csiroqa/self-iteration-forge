/**
 * plugin-forge —— 迁移与落地（staging → 独立仓库）。
 *
 * 职责：把子代理在 staging 目录开发的插件复制为 targetRoot 下的独立仓库，
 * 把 package.json 里的 deepseek-harness link: 依赖改写为目标目录的相对路径，
 * 并确保 .gitignore 覆盖 node_modules 等不该提交的内容。
 */
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relativeLink, toPosix } from './utils.ts'

/** 复制时排除的目录（node_modules 体积大且可在目标目录重建）。 */
const EXCLUDED_BASENAMES = new Set(['node_modules', '.git', '.pnpm-store'])

/** 判断路径是否存在（文件或目录）。 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 把 source 目录的内容复制进 target（合并覆盖）。
 * 排除 node_modules / .git / .pnpm-store。
 */
export async function copyInto(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: (src) => !EXCLUDED_BASENAMES.has(path.basename(src)),
  })
}

/**
 * 把 package.json 中所有指向 deepseek-harness 检出的 link: 依赖
 * 改写为从 toDir 出发的相对路径（staging 深度 → 目标目录深度）。
 * 返回改写数量；harnessRoot 是 deepseek-harness 检出根（绝对路径）。
 */
export async function rewriteHarnessLinks(
  packageJsonPath: string,
  fromDir: string,
  toDir: string,
  harnessRoot: string,
): Promise<number> {
  const file = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(file) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const harnessPrefix = `${toPosix(path.resolve(harnessRoot))}/`
  let changed = 0
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section]
    if (deps === undefined) continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const absolute = toPosix(path.resolve(fromDir, spec.slice('link:'.length)))
      if (absolute !== toPosix(path.resolve(harnessRoot)) && !absolute.startsWith(harnessPrefix)) continue
      const rel = relativeLink(toDir, absolute)
      if (rel !== spec.slice('link:'.length)) {
        deps[dep] = `link:${rel}`
        changed += 1
      }
    }
  }
  if (changed > 0) {
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
  return changed
}

/** 独立仓库必须忽略的条目（幂等补齐；不删除用户已有内容）。 */
const STANDARD_IGNORES = [
  'node_modules/',
  'lib/',
  'dist/',
  '*.tsbuildinfo',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
]

/** 确保目录下存在 .gitignore 且包含标准忽略项（幂等）。 */
export async function ensureGitignore(dir: string): Promise<void> {
  const file = path.join(dir, '.gitignore')
  let lines: string[] = []
  try {
    lines = (await readFile(file, 'utf8')).split(/\r?\n/)
  } catch {
    // 不存在则新建。
  }
  const missing = STANDARD_IGNORES.filter((entry) => !lines.some((line) => line.trim() === entry))
  if (missing.length === 0) return
  const base = lines.join('\n').trimEnd()
  const content = `${base === '' ? '' : `${base}\n`}${missing.join('\n')}\n`
  await writeFile(file, content, 'utf8')
}
