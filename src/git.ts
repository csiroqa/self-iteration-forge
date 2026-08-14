/**
 * plugin-forge —— git 仓库操作（host 半区，非沙箱 shell）。
 *
 * 职责单一：确保仓库存在、暂存全部改动、检查是否有可提交变更、
 * 用英文 Conventional Commit 提交。提交前必须检查 diff（AGENTS.md）。
 * 不做 push / tag / release（默认禁止，除非配置明确要求）。
 */
import { assertOk, runCommand, type ExecResult } from './utils.ts'

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

/** 仓库（含全局）是否已配置作者身份；未配置时返回应注入的回退身份。 */
export async function resolveIdentity(dir: string, fallback: GitIdentity): Promise<GitIdentity | undefined> {
  const name = await runCommand('git', ['config', 'user.name'], { cwd: dir })
  const email = await runCommand('git', ['config', 'user.email'], { cwd: dir })
  const hasName = name.code === 0 && name.stdout.trim() !== ''
  const hasEmail = email.code === 0 && email.stdout.trim() !== ''
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
 * 返回是否真的产生了提交。
 */
export async function commitStaged(
  dir: string,
  subject: string,
  identity: GitIdentity,
): Promise<boolean> {
  const fallback = await resolveIdentity(dir, identity)
  const args = fallback === undefined
    ? ['commit', '-m', subject]
    : ['-c', `user.name=${fallback.name}`, '-c', `user.email=${fallback.email}`, 'commit', '-m', subject]
  const result: ExecResult = await runCommand('git', args, { cwd: dir })
  if (result.code !== 0) {
    throw new Error(`git commit 失败（exit=${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 2000)}`)
  }
  return true
}
