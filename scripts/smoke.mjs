/**
 * plugin-forge —— 冒烟测试（构建后运行，验证 lib 可加载且核心函数可用）。
 *
 * 不依赖 DSH 运行时，只验证：lib/index.js 可被 Node 直接加载、
 * 命名/slug/link 改写/.gitignore/git 提交链路在真实文件系统上工作。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertOk,
  commitStaged,
  ensureGitignore,
  ensureGitRepo,
  normalizePluginName,
  relativeLink,
  rewriteHarnessLinks,
  runCommand,
  slugFromRequirement,
  stageAll,
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

const root = await mkdtemp(path.join(tmpdir(), 'plugin-forge-smoke-'))
try {
  console.log('plugin-forge smoke: lib 加载成功')

  check('normalizePluginName', normalizePluginName('My Cool Plugin!', 'x') === 'my-cool-plugin')
  check('slugFromRequirement', slugFromRequirement('Create a plugin for web search memo') === 'web-search-memo')

  // link 改写（staging 比 target 深两级，必须改写前缀）。
  const staging = path.join(root, 'staging', 'inner', 'pkg')
  const target = path.join(root, 'repos', 'pkg')
  const harness = path.join(root, 'deepseek-harness')
  await mkdir(staging, { recursive: true })
  const pkgPath = path.join(staging, 'package.json')
  await writeFile(pkgPath, JSON.stringify({
    dependencies: {
      '@deepseek-ai/cordis': `link:${relativeLink(staging, path.join(harness, 'vendor/cordis'))}`,
    },
  }))
  const changed = await rewriteHarnessLinks(pkgPath, staging, target, harness)
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
