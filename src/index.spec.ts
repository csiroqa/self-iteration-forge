/**
 * plugin-forge —— 单元测试。
 *
 * 覆盖纯逻辑（命名、slug、link 改写、.gitignore、登记表读写）
 * 与 git 集成链路（init → add → diff → commit，真实 git，临时目录）。
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureGitignore, rewriteCiHarnessPaths, rewriteHarnessLinks, syncRemoveStale } from './migrate.ts'
import { assertNoRegistryHarnessDeps } from './forge.ts'
import { commitStaged, ensureGitRepo, stageAll } from './git.ts'
import { loadRegistry, saveRegistry } from './registry.ts'
import {
  buildCommitSubject,
  normalizePluginName,
  relativeLink,
  samePath,
  slugFromRequirement,
  toPosix,
} from './utils.ts'

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
  it('无有效英文单词时用需求哈希做稳定唯一后缀', () => {
    const first = slugFromRequirement('做一个支持定时任务的插件')
    const second = slugFromRequirement('做一个支持定时任务的插件')
    const other = slugFromRequirement('做一个支持会话归档的插件')
    expect(first).toMatch(/^dsh-plugin-[0-9a-f]{8}$/)
    expect(second).toBe(first) // 同一需求 → 同一名字
    expect(other).not.toBe(first) // 不同需求 → 不同名字
  })
})

describe('samePath', () => {
  it('Windows 下大小写不敏感，去尾斜杠', () => {
    expect(samePath('D:/2-OGP/demo', 'D:/2-OGP/demo/')).toBe(true)
    expect(samePath('D:/2-OGP/demo', 'd:/2-ogp/DEMO')).toBe(process.platform === 'win32')
    expect(samePath('D:/2-OGP/demo', 'D:/2-OGP/other')).toBe(false)
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

describe('buildCommitSubject（Conventional Commit 卫生）', () => {
  it('组装 type: name: summary 且总长 ≤72', () => {
    const subject = buildCommitSubject('feat', 'web-search-memo', 'add keyword search for session memos')
    expect(subject).toBe('feat: web-search-memo: add keyword search for session memos')
    expect(subject.length).toBeLessThanOrEqual(72)
  })

  it('清洗非 ASCII 与换行', () => {
    expect(buildCommitSubject('feat', 'demo', '中文摘要\n带换行')).toBe('feat: demo')
    expect(buildCommitSubject('feat', 'demo', 'hello\nworld')).toBe('feat: demo: hello world')
  })

  it('超长摘要按 72 字符预算截断', () => {
    const subject = buildCommitSubject('feat', 'a-very-long-plugin-name', 'x'.repeat(200))
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.startsWith('feat: a-very-long-plugin-name: ')).toBe(true)
  })

  it('非法 commitType 回退为 feat', () => {
    expect(buildCommitSubject('Bad Type!', 'demo', 'ok')).toBe('feat: demo: ok')
  })

  it('无摘要时只输出 type: name', () => {
    expect(buildCommitSubject('fix', 'demo', undefined)).toBe('fix: demo')
    expect(buildCommitSubject('fix', 'demo', '   ')).toBe('fix: demo')
  })
})

describe('assertNoRegistryHarnessDeps', () => {
  it('拒绝 registry 版本号的 @deepseek-ai/* 依赖', async () => {
    const dir = path.join(tempRoot, 'pkg')
    await mkdir(dir, { recursive: true })
    const pkgPath = path.join(dir, 'package.json')
    await writeFile(pkgPath, JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-llm': '^0.1.0', 'normal-dep': '^1.0.0' },
      devDependencies: { '@deepseek-ai/cordis': 'link:../deepseek-harness/vendor/cordis' },
    }))
    await expect(assertNoRegistryHarnessDeps(pkgPath, path.join(tempRoot, 'deepseek-harness')))
      .rejects.toThrow(/dsh-llm/)
  })

  it('全部 link: 时通过', async () => {
    const dir = path.join(tempRoot, 'pkg')
    await mkdir(dir, { recursive: true })
    const pkgPath = path.join(dir, 'package.json')
    await writeFile(pkgPath, JSON.stringify({
      dependencies: { '@deepseek-ai/cordis': 'link:../deepseek-harness/vendor/cordis' },
    }))
    await expect(assertNoRegistryHarnessDeps(pkgPath, path.join(tempRoot, 'deepseek-harness'))).resolves.toBeUndefined()
  })
})

describe('syncRemoveStale（更新同步语义）', () => {
  it('删除 target 中 source 已不存在的文件，保护 .git/node_modules/lib', async () => {
    const source = path.join(tempRoot, 'src-repo')
    const target = path.join(tempRoot, 'target-repo')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await mkdir(path.join(target, 'src'), { recursive: true })
    await mkdir(path.join(target, '.git'), { recursive: true })
    await mkdir(path.join(target, 'node_modules'), { recursive: true })
    await mkdir(path.join(target, 'lib'), { recursive: true })
    // 双方都有：保留。
    await writeFile(path.join(source, 'src', 'index.ts'), 'new')
    await writeFile(path.join(target, 'src', 'index.ts'), 'old')
    // target 独有：删除。
    await writeFile(path.join(target, 'legacy.txt'), 'stale')
    await writeFile(path.join(target, 'src', 'removed.ts'), 'stale')
    // 受保护：保留。
    await writeFile(path.join(target, '.git', 'config'), 'git')
    await writeFile(path.join(target, 'node_modules', 'dep.js'), 'dep')
    await writeFile(path.join(target, 'lib', 'index.js'), 'built')

    const removed = await syncRemoveStale(source, target)
    expect(removed).toBe(2)
    // 双方都有的文件：保留（内容覆盖是 copyInto 的职责，此处不动）。
    await expect(readFile(path.join(target, 'src', 'index.ts'), 'utf8')).resolves.toBe('old')
    await expect(stat(path.join(target, 'legacy.txt'))).rejects.toThrow()
    await expect(stat(path.join(target, 'src', 'removed.ts'))).rejects.toThrow()
    await expect(stat(path.join(target, '.git', 'config'))).resolves.toBeDefined()
    await expect(stat(path.join(target, 'node_modules', 'dep.js'))).resolves.toBeDefined()
    await expect(stat(path.join(target, 'lib', 'index.js'))).resolves.toBeDefined()
  })
})

describe('rewriteCiHarnessPaths', () => {
  it('把 ci.yml 中的 deepseek-harness 相对路径对齐到目标深度', async () => {
    const staging = path.join(tempRoot, 'staging', 'inner', 'pkg')
    const target = path.join(tempRoot, 'repos', 'pkg')
    const harness = path.join(tempRoot, 'deepseek-harness')
    const ciDir = path.join(staging, '.github', 'workflows')
    await mkdir(ciDir, { recursive: true })
    const ciPath = path.join(ciDir, 'ci.yml')
    await writeFile(ciPath, [
      '      # 依赖以 link: 指向 ../../../deepseek-harness（交付目录前缀）',
      '      - name: Checkout deepseek-harness (sibling)',
      '        run: git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness ../../../deepseek-harness',
      '      - name: Build harness libraries',
      '        working-directory: ../../../deepseek-harness',
      '        run: pnpm install',
      '',
    ].join('\n'))

    const replaced = await rewriteCiHarnessPaths(ciPath, target, harness)
    expect(replaced).toBe(3)
    const rewritten = await readFile(ciPath, 'utf8')
    // 替换后应为 target → harness 的完整相对路径（relativeLink 本身已含 deepseek-harness 结尾）。
    const expected = relativeLink(target, harness)
    expect(rewritten).not.toContain('../../../deepseek-harness')
    expect(rewritten).not.toContain(`${expected}/deepseek-harness`)
    expect(rewritten).toContain(`git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness ${expected}`)
    expect(rewritten).toContain(`working-directory: ${expected}`)
  })

  it('文件不存在或无匹配时返回 0', async () => {
    const missing = path.join(tempRoot, 'nope.yml')
    expect(await rewriteCiHarnessPaths(missing, tempRoot, path.join(tempRoot, 'deepseek-harness'))).toBe(0)
    const dir = path.join(tempRoot, 'pkg')
    await mkdir(dir, { recursive: true })
    const ciPath = path.join(dir, 'ci.yml')
    await writeFile(ciPath, 'name: ci\non: [push]\n')
    expect(await rewriteCiHarnessPaths(ciPath, tempRoot, path.join(tempRoot, 'deepseek-harness'))).toBe(0)
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
