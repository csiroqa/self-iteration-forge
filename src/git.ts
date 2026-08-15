/** git 操作：ensure/stage/commit（提交前检查 diff；不 push/tag/release，除非配置显式开启）。 */
import { assertOk, runCommand, CommandFailedError } from './utils.ts'

/** 提交作者身份（仓库未配置 user.name/user.email 时的回退）。 */
export interface GitIdentity {
  readonly name: string
  readonly email: string
}

/** 目录是否已是 git 工作树。 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** 若目录还不是 git 仓库，则初始化。 */
export async function ensureGitRepo(dir: string): Promise<void> {
  if (await isGitRepo(dir)) return
  await assertOk(await runCommand('git', ['init'], { cwd: dir }), 'git init')
}

/**
 * 仓库（含全局）是否已配置作者身份；未配置时返回应注入的回退身份。
 * 用单次 git config --list 读取 user.name/user.email，避免两次子进程。
 */
export async function resolveIdentity(dir: string, fallback: GitIdentity): Promise<GitIdentity | undefined> {
  const result = await runCommand('git', ['config', '--list'], { cwd: dir })
  if (result.code !== 0) return fallback
  const hasName = /(^|\n)user\.name=/.test(`\n${result.stdout}`)
  const hasEmail = /(^|\n)user\.email=/.test(`\n${result.stdout}`)
  return hasName && hasEmail ? undefined : fallback
}

/** 暂存全部改动；返回是否存在可提交的变更（提交前先检查 diff）。 */
export async function stageAll(dir: string): Promise<boolean> {
  await assertOk(await runCommand('git', ['add', '-A'], { cwd: dir }), 'git add -A')
  const diff = await runCommand('git', ['diff', '--cached', '--quiet'], { cwd: dir })
  if (diff.code === 0) return false
  if (diff.code === 1) return true
  throw new Error(`git diff --cached --quiet 异常退出（exit=${diff.code}）：${diff.stderr.trim()}`)
}

/**
 * 提交暂存改动。subject 必须是英文 Conventional Commit（如
 * `feat: web-search-memo: add keyword search for session memos`）。
 * 是否真的有改动由调用方先经 stageAll 判断（本函数只负责提交，
 * 不再重复 diff 检查）；失败时抛出 CommandFailedError。
 */
export async function commitStaged(
  dir: string,
  subject: string,
  identity: GitIdentity,
): Promise<void> {
  const fallback = await resolveIdentity(dir, identity)
  const args = fallback === undefined
    ? ['commit', '-m', subject]
    : ['-c', `user.name=${fallback.name}`, '-c', `user.email=${fallback.email}`, 'commit', '-m', subject]
  const result = await runCommand('git', args, { cwd: dir })
  if (result.code !== 0) {
    throw new CommandFailedError('git commit', result)
  }
}
