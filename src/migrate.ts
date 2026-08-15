/** 迁移落地：复制独立仓库、改写 deepseek-harness link/CI 路径、补齐 .gitignore、更新同步删除。 */
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relativeLink } from './utils.ts'

/** 复制时排除的目录（node_modules 体积大且可在目标目录重建）。 */
export const EXCLUDED_BASENAMES = new Set(['node_modules', '.git', '.pnpm-store'])

/** 同步删除时保护的目录（仓库元数据与构建产物/依赖，不做源文件同步）。 */
const SYNC_PROTECTED_BASENAMES = new Set(['.git', 'node_modules', '.pnpm-store', 'lib', 'dist'])

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
  toDir: string,
  harnessRoot: string,
): Promise<number> {
  const file = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(file) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  // 目标深度前缀（如 ../deepseek-harness）。
  const targetPrefix = relativeLink(toDir, harnessRoot)
  let changed = 0
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section]
    if (deps === undefined) continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const linkPath = spec.slice('link:'.length)
      // 只处理指向 deepseek-harness 的链接；保留其后的子路径（/vendor/cordis 等）。
      // 统一归一化到目标目录深度，覆盖三种场景：
      //   create（staging 深度 ../../../）、update 预填充（已是目标深度 ../，幂等不变）、
      //   子代理误写任意深度。
      const marker = linkPath.indexOf('deepseek-harness')
      if (marker < 0) continue
      const suffix = linkPath.slice(marker + 'deepseek-harness'.length)
      const desired = `${targetPrefix}${suffix}`
      if (linkPath !== desired) {
        deps[dep] = `link:${desired}`
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

/**
 * 改写 .github/workflows/ci.yml 中指向 deepseek-harness 的相对路径
 * （git clone 目标、working-directory 等），使其从 staging 深度对齐到
 * 目标目录深度——与 package.json 的 link: 改写配套，否则 CI 会 clone
 * 到错误位置。返回被替换的路径出现次数；文件不存在或无匹配返回 0。
 */
export async function rewriteCiHarnessPaths(ciPath: string, toDir: string, harnessRoot: string): Promise<number> {
  let text: string
  try {
    text = await readFile(ciPath, 'utf8')
  } catch {
    return 0
  }
  const pattern = /(\.\.\/)+deepseek-harness/g
  const occurrences = text.match(pattern) ?? []
  if (occurrences.length === 0) return 0
  // relativeLink 已经是以 deepseek-harness 结尾的完整相对路径，直接整体替换，
  // 不要再用 posix.join 追加目录名（会双写成 …/deepseek-harness/deepseek-harness）。
  const replacement = relativeLink(toDir, harnessRoot)
  await writeFile(ciPath, text.replace(pattern, replacement), 'utf8')
  return occurrences.length
}

/**
 * 删除 target 中存在但 source 中不存在的文件（更新同步语义）。
 * .git / node_modules / .pnpm-store / lib / dist 受保护，不做同步删除；
 * 空目录一并清理。返回删除的文件数量。
 */
export async function syncRemoveStale(source: string, target: string): Promise<number> {
  let removed = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SYNC_PROTECTED_BASENAMES.has(entry.name)) continue
      const targetFull = path.join(dir, entry.name)
      const rel = path.relative(target, targetFull)
      const sourceFull = path.join(source, rel)
      if (entry.isDirectory()) {
        await walk(targetFull)
        // 子目录处理完后，若为空且 source 无对应文件，删除该空目录。
        try {
          const remaining = await readdir(targetFull)
          if (remaining.length === 0 && !(await pathExists(sourceFull))) {
            await rm(targetFull, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          // 已被并发清理或不存在，忽略。
        }
      } else if (!(await pathExists(sourceFull))) {
        await rm(targetFull, { force: true })
        removed += 1
      }
    }
  }
  await walk(target)
  return removed
}
