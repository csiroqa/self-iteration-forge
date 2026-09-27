/**
 * profile 探测 —— detectActiveProfile。
 * 规则：profiles 目录下 bundle 含 @deepseek-ai/dsh-web-app 的 profile 视为当前激活；
 * 唯一命中返回目录名，零个或多个返回 undefined。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectActiveProfile, WEB_APP_BUNDLE } from './profile.ts'

let tempRoot: string
let profilesDir: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'self-iteration-forge-profile-'))
  profilesDir = path.join(tempRoot, 'profiles')
  await mkdir(profilesDir, { recursive: true })
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

async function writeProfile(name: string, bundles: string[]): Promise<void> {
  await mkdir(path.join(profilesDir, name), { recursive: true })
  await writeFile(
    path.join(profilesDir, name, 'package.json'),
    JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles } } }),
    'utf8',
  )
}

describe('detectActiveProfile', () => {
  it('唯一 web profile 命中其目录名', async () => {
    await writeProfile('web', ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
    await expect(detectActiveProfile(profilesDir)).resolves.toBe('web')
  })

  it('多个 profile 时只认含 web-app bundle 的那个', async () => {
    await writeProfile('demo', ['@deepseek-ai/dsh-base'])
    await writeProfile('web', ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
    await expect(detectActiveProfile(profilesDir)).resolves.toBe('web')
  })

  it('无 web profile 时返回 undefined', async () => {
    await writeProfile('tui', ['@deepseek-ai/dsh-base'])
    await expect(detectActiveProfile(profilesDir)).resolves.toBeUndefined()
  })

  it('多个 web profile（歧义）返回 undefined', async () => {
    await writeProfile('web', [WEB_APP_BUNDLE])
    await writeProfile('web-2', [WEB_APP_BUNDLE])
    await expect(detectActiveProfile(profilesDir)).resolves.toBeUndefined()
  })

  it('profiles 目录不存在返回 undefined', async () => {
    await expect(detectActiveProfile(path.join(tempRoot, 'no-such-dir'))).resolves.toBeUndefined()
  })

  it('package.json 损坏或缺失的目录被跳过', async () => {
    await writeProfile('web', [WEB_APP_BUNDLE])
    await mkdir(path.join(profilesDir, 'broken'), { recursive: true })
    await writeFile(path.join(profilesDir, 'broken', 'package.json'), 'not json', 'utf8')
    await mkdir(path.join(profilesDir, 'empty'), { recursive: true })
    await expect(detectActiveProfile(profilesDir)).resolves.toBe('web')
  })

  it('node_modules 目录被跳过', async () => {
    await writeProfile('node_modules', [WEB_APP_BUNDLE])
    await expect(detectActiveProfile(profilesDir)).resolves.toBeUndefined()
  })
})
