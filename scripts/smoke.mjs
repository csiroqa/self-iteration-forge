/**
 * self-iteration-forge —— 冒烟测试（构建后运行，验证 lib 可加载且核心函数可用）。
 *
 * 不依赖 DSH 运行时，只验证：lib/index.js 可被 Node 直接加载、
 * 命名/slug/link 改写/.gitignore/git 提交链路在真实文件系统上工作。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertNoRegistryHarnessDeps,
  assertOk,
  buildCommitSubject,
  commitStaged,
  ensureGitignore,
  ensureGitRepo,
  normalizePluginName,
  relativeLink,
  rewriteHarnessLinks,
  runCommand,
  samePath,
  slugFromRequirement,
  stageAll,
  syncRemoveStale,
} from '../lib/index.js'

let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok: ${name}`)
  } else {
    failed += 1
    console.error(`FAIL: ${name} ${detail}`)
  }
}

const root = await mkdtemp(path.join(tmpdir(), 'self-iteration-forge-smoke-'))
const harness = path.join(root, 'deepseek-harness')
try {
  console.log('self-iteration-forge smoke: lib 加载成功')

  check('normalizePluginName', normalizePluginName('My Cool Plugin!', 'x') === 'my-cool-plugin')
  check('slugFromRequirement', slugFromRequirement('Create a plugin for web search memo') === 'web-search-memo')
  check(
    'slugFromRequirement 中文需求哈希后缀',
    /^dsh-plugin-[0-9a-f]{8}$/.test(slugFromRequirement('做一个支持定时任务的插件')),
  )
  check('samePath 大小写不敏感', samePath('D:/2-OGP/demo', 'd:/2-ogp/DEMO') === (process.platform === 'win32'))
  check(
    'buildCommitSubject',
    buildCommitSubject('feat', 'web-search-memo', 'add keyword search for session memos')
      === 'feat: web-search-memo: add keyword search for session memos',
  )
  check('buildCommitSubject 超长截断', buildCommitSubject('feat', 'x', 'y'.repeat(200)).length <= 72)

  // 依赖守卫。
  const guarded = path.join(root, 'guarded')
  await mkdir(guarded, { recursive: true })
  await writeFile(path.join(guarded, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh-llm': '^0.1.0' },
  }))
  let guardRejected = false
  try {
    await assertNoRegistryHarnessDeps(path.join(guarded, 'package.json'), harness)
  } catch {
    guardRejected = true
  }
  check('assertNoRegistryHarnessDeps 拒绝 registry 版本', guardRejected)

  // link 改写（staging 比 target 深两级，必须改写前缀）。
  const staging = path.join(root, 'staging', 'inner', 'pkg')
  const target = path.join(root, 'repos', 'pkg')
  await mkdir(staging, { recursive: true })
  const pkgPath = path.join(staging, 'package.json')
  await writeFile(pkgPath, JSON.stringify({
    dependencies: {
      '@deepseek-ai/cordis': `link:${relativeLink(staging, path.join(harness, 'vendor/cordis'))}`,
    },
  }))
  const changed = await rewriteHarnessLinks(pkgPath, target, harness)
  check('rewriteHarnessLinks', changed === 1)
  const rewritten = JSON.parse(await readFile(pkgPath, 'utf8'))
  check(
    'rewriteHarnessLinks 目标路径',
    rewritten.dependencies['@deepseek-ai/cordis'] === `link:${relativeLink(target, path.join(harness, 'vendor/cordis'))}`,
  )

  // .gitignore 幂等。
  const repo = path.join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await ensureGitignore(repo)
  const first = await readFile(path.join(repo, '.gitignore'), 'utf8')
  await ensureGitignore(repo)
  const second = await readFile(path.join(repo, '.gitignore'), 'utf8')
  check('ensureGitignore 幂等', first === second)

  // 同步删除：target 独有文件被删，node_modules 受保护。
  const syncSrc = path.join(root, 'sync-src')
  const syncTarget = path.join(root, 'sync-target')
  await mkdir(syncSrc, { recursive: true })
  await mkdir(path.join(syncTarget, 'node_modules'), { recursive: true })
  await writeFile(path.join(syncSrc, 'keep.txt'), 'keep')
  await writeFile(path.join(syncTarget, 'keep.txt'), 'old')
  await writeFile(path.join(syncTarget, 'stale.txt'), 'stale')
  await writeFile(path.join(syncTarget, 'node_modules', 'dep.js'), 'dep')
  const removed = await syncRemoveStale(syncSrc, syncTarget)
  check('syncRemoveStale 删除过期文件', removed === 1)
  // stale.txt 是 target 独有文件，应已被删除（stat 抛错即通过）。
  let staleGone = true
  try {
    await import('node:fs/promises').then(({ stat }) => stat(path.join(syncTarget, 'stale.txt')))
    staleGone = false
  } catch {
    // 已删除。
  }
  check('syncRemoveStale 删除过期 stale.txt', staleGone)
  // node_modules 受保护：dep.js 应仍然存在（直接断言，不靠 removed 计数间接推断）。
  let depProtected = true
  try {
    await import('node:fs/promises').then(({ stat }) => stat(path.join(syncTarget, 'node_modules', 'dep.js')))
  } catch {
    depProtected = false
  }
  check('syncRemoveStale 保护 node_modules', depProtected)

  // git 链路：init → add → commit → 无改动不再提交。
  await ensureGitRepo(repo)
  await writeFile(path.join(repo, 'hello.txt'), 'hi\n')
  check('stageAll 首次有改动', await stageAll(repo))
  await commitStaged(repo, 'feat: demo: add hello file', { name: 'Smoke', email: 'smoke@local' })
  const log = await assertOk(await runCommand('git', ['log', '-1', '--format=%s'], { cwd: repo }), 'git log')
  check('commit subject', log.stdout.trim() === 'feat: demo: add hello file', `got: ${log.stdout.trim()}`)
  check('stageAll 无改动返回 false', !(await stageAll(repo)))

  console.log(failed === 0 ? 'smoke: 全部通过' : `smoke: ${failed} 项失败`)
} finally {
  await rm(root, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
