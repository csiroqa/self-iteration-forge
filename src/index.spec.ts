/**
 * plugin-forge —— 单元测试。
 *
 * 覆盖纯逻辑（命名、slug、link 改写、.gitignore、登记表读写）
 * 与 git 集成链路（init → add → diff → commit，真实 git，临时目录）。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureGitignore, rewriteHarnessLinks } from './migrate.ts'
import { commitStaged, ensureGitRepo, stageAll } from './git.ts'
import { loadRegistry, saveRegistry } from './registry.ts'
import { normalizePluginName, relativeLink, slugFromRequirement, toPosix } from './utils.ts'

let tempRoot: string
let savedHome: string | undefined

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plugin-forge-spec-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(tempRoot, 'dsh-home')
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  await rm(tempRoot, { recursive: true, force: true })
})

describe('normalizePluginName', () => {
  it('清洗非法字符并转 kebab-case', () => {
    expect(normalizePluginName('My Cool Plugin!', 'x')).toBe('my-cool-plugin')
    expect(normalizePluginName('  web-search_memo  ', 'x')).toBe('web-search-memo')
    expect(normalizePluginName('---', 'fallback')).toBe('fallback')
    expect(normalizePluginName(undefined, 'fallback')).toBe('fallback')
  })
})

describe('slugFromRequirement', () => {
  it('从需求提取有意义的英文单词', () => {
    expect(slugFromRequirement('Create a plugin for web search memo')).toBe('web-search-memo')
  })
  it('无有效英文单词时回退', () => {
    expect(slugFromRequirement('做一个支持定时任务的插件')).toBe('dsh-plugin')
  })
})

describe('relativeLink', () => {
  it('计算相对路径并用正斜杠', () => {
    expect(relativeLink('D:/a/b/c', 'D:/a/b/c/deepseek-harness')).toBe('deepseek-harness')
    expect(relativeLink('D:/a/b/c/d', 'D:/a/b/c')).toBe('..')
    expect(relativeLink('D:/a/b/c', 'D:/a')).toBe('../..')
  })
})

describe('rewriteHarnessLinks', () => {
  it('把 staging 深度的 link 改写为目标目录深度', async () => {
    // staging 比 target 深两级，link 前缀必须改写。
    const staging = path.join(tempRoot, 'staging', 'inner', 'pkg')
    const target = path.join(tempRoot, 'repos', 'pkg')
    const harness = path.join(tempRoot, 'deepseek-harness')
    await mkdir(staging, { recursive: true })
    const pkgPath = path.join(staging, 'package.json')
    await writeFile(pkgPath, JSON.stringify({
      dependencies: {
        '@deepseek-ai/cordis': `link:${relativeLink(staging, path.join(harness, 'vendor/cordis'))}`,
        'normal-dep': '^1.0.0',
      },
      devDependencies: {
        'typescript': '^5.9.3',
        '@deepseek-ai/dsh-tools': `link:${relativeLink(staging, path.join(harness, 'packages/core/tools'))}`,
      },
    }, null, 2))

    const changed = await rewriteHarnessLinks(pkgPath, staging, target, harness)
    expect(changed).toBe(2)

    const rewritten = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(rewritten.dependencies['@deepseek-ai/cordis']).toBe(`link:${relativeLink(target, path.join(harness, 'vendor/cordis'))}`)
    expect(rewritten.devDependencies['@deepseek-ai/dsh-tools']).toBe(`link:${relativeLink(target, path.join(harness, 'packages/core/tools'))}`)
    expect(rewritten.dependencies['normal-dep']).toBe('^1.0.0')
  })

  it('不触及与 deepseek-harness 无关的 link 依赖', async () => {
    const staging = path.join(tempRoot, 'staging', 'pkg')
    const target = path.join(tempRoot, 'repos', 'pkg')
    const harness = path.join(tempRoot, 'deepseek-harness')
    await mkdir(staging, { recursive: true })
    const pkgPath = path.join(staging, 'package.json')
    await writeFile(pkgPath, JSON.stringify({ dependencies: { 'some-local': 'link:../other-lib' } }))
    const changed = await rewriteHarnessLinks(pkgPath, staging, target, harness)
    expect(changed).toBe(0)
  })
})

describe('ensureGitignore', () => {
  it('缺失时创建并包含标准忽略项', async () => {
    const dir = path.join(tempRoot, 'repo')
    await mkdir(dir, { recursive: true })
    await ensureGitignore(dir)
    const content = await readFile(path.join(dir, '.gitignore'), 'utf8')
    expect(content).toContain('node_modules/')
    expect(content).toContain('lib/')
  })

  it('幂等：重复调用不重复追加', async () => {
    const dir = path.join(tempRoot, 'repo')
    await mkdir(dir, { recursive: true })
    await ensureGitignore(dir)
    const first = await readFile(path.join(dir, '.gitignore'), 'utf8')
    await ensureGitignore(dir)
    const second = await readFile(path.join(dir, '.gitignore'), 'utf8')
    expect(second).toBe(first)
  })
})

describe('registry', () => {
  it('空表往返与 upsert 语义', async () => {
    const empty = await loadRegistry()
    expect(empty.repos).toEqual([])

    const now = new Date().toISOString()
    await saveRegistry({
      version: 1,
      repos: [{ name: 'demo', path: toPosix(path.join(tempRoot, 'demo')), createdAt: now, lastCommitAt: now, commitCount: 1 }],
    })
    const loaded = await loadRegistry()
    expect(loaded.repos).toHaveLength(1)
    expect(loaded.repos[0]?.name).toBe('demo')
    expect(loaded.repos[0]?.commitCount).toBe(1)
  })
})

describe('git 集成（真实 git，临时目录）', () => {
  it('init → add → commit 全链路，提交 subject 正确，无改动不重复提交', async () => {
    const repo = path.join(tempRoot, 'repo')
    await mkdir(repo, { recursive: true })
    await ensureGitRepo(repo)
    await writeFile(path.join(repo, 'hello.txt'), 'hi\n')
    expect(await stageAll(repo)).toBe(true)
    const committed = await commitStaged(repo, 'feat: demo: add hello file', {
      name: 'Forge Test',
      email: 'forge@test.local',
    })
    expect(committed).toBe(true)
    // 验证提交确实存在且 subject 正确。
    const { runCommand } = await import('./utils.ts')
    const log = await runCommand('git', ['log', '-1', '--format=%s'], { cwd: repo })
    expect(log.code).toBe(0)
    expect(log.stdout.trim()).toBe('feat: demo: add hello file')
    // 无新改动时 stageAll 返回 false（提交前检查 diff）。
    expect(await stageAll(repo)).toBe(false)
  })
})
