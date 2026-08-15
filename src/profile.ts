/**
 * DSH profile 探测：$DSH_HOME/profiles/<name>/package.json 中
 * dsh.profile.bundles 含 WEB_APP_BUNDLE 者视为当前激活的 profile。
 * 用于 forge 成功后自动装入（agent 不能自发重启，热挂载覆盖本会话、
 * profile 装入覆盖重启后）。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** web 前端 profile 的标识 bundle（dsh web 启动的 profile 必含）。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

interface ProfilePackage {
  readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } }
}

/**
 * 探测当前激活的 profile 名。
 * 唯一命中返回目录名；零个（非 web 会话）或多个（歧义）返回 undefined。
 */
export async function detectActiveProfile(profilesDir: string): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  let found: string | undefined
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    let pkg: ProfilePackage
    try {
      pkg = JSON.parse(await readFile(path.join(profilesDir, entry.name, 'package.json'), 'utf8')) as ProfilePackage
    } catch {
      // 不是可解析的 profile package.json（如备份/残留目录），跳过。
      continue
    }
    if (pkg.dsh?.profile?.bundles?.includes(WEB_APP_BUNDLE) === true) {
      if (found !== undefined) return undefined
      found = entry.name
    }
  }
  return found
}
