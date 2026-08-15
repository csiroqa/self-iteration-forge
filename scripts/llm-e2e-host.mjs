/**
 * plugin-forge —— 真实 LLM 实例测试的宿主侧脚本。
 *
 * 两个模式：
 *   node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> <requirement> [create|update]
 *     生成并打印 forge 子代理的真实提示词（buildChildPrompt），
 *     供外部把 LLM 子代理接到 staging 目录上执行。
 *   node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> <commitSubject>
 *     子代理完成后执行宿主侧全流程：迁移 → link 改写 → 依赖守卫 →
 *     .gitignore → 目标目录 pnpm install+build（含 main/types 校验）→
 *     git init/add/diff/commit → 登记进 $DSH_HOME/plugin-forge.json。
 *
 * 这是 runForge 的"人工注入 startChild"等价路径：子代理由外部真实 LLM
 * 执行，宿主侧复用 lib 的同一批函数。
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  assertNoRegistryHarnessDeps,
  buildChildPrompt,
  commitStaged,
  copyInto,
  ensureGitRepo,
  ensureGitignore,
  pathExists,
  rewriteCiHarnessPaths,
  rewriteHarnessLinks,
  stageAll,
  syncRemoveStale,
  toPosix,
  upsertRepo,
  verifyBuildInTarget,
} from '../lib/index.js'

function usage() {
  console.error('用法（注意参数顺序，requirement/subject 在最后；可选第 7 参数）：')
  console.error('  node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> <requirement> [create|update]')
  console.error('  node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> <commitSubject> [--update]')
  process.exit(2)
}

const [, , mode, name, stagingDir, targetRoot, harnessRoot, extra, flag] = process.argv

if (mode === 'prompt') {
  if (name === undefined || stagingDir === undefined || targetRoot === undefined || harnessRoot === undefined || extra === undefined) usage()
  const childMode = flag === 'update' ? 'update' : 'create'
  const promptText = buildChildPrompt({
    requirement: extra,
    name,
    mode: childMode,
    stagingDir,
    harnessRoot,
    relativeHarnessPath: path.relative(stagingDir, harnessRoot).split(path.sep).join('/'),
    targetRoot,
    referenceRepos: [
      'D:/2-OGP/dsh-plugin/plugins/system-notify',
      'D:/2-OGP/dsh-hotkeys',
      'D:/2-OGP/dsh-plugin/plugins/command-opt',
    ],
  })
  process.stdout.write(promptText)
  process.exit(0)
}

if (mode === 'run') {
  if (name === undefined || stagingDir === undefined || targetRoot === undefined || harnessRoot === undefined || extra === undefined) usage()
  const commitSubject = extra
  const isUpdate = flag === '--update'
  const staging = path.resolve(stagingDir)
  const target = path.resolve(targetRoot, name)
  const harness = path.resolve(harnessRoot)

  // 0. staging 校验。
  const files = await readdir(staging, { withFileTypes: true })
  if (files.length === 0) throw new Error(`staging 为空：${toPosix(staging)}`)
  const targetExists = await pathExists(target)
  if (targetExists && !isUpdate) {
    throw new Error(`目标目录已存在：${toPosix(target)}（更新请传 --update）`)
  }
  if (!targetExists && isUpdate) {
    throw new Error(`--update 但目标目录不存在：${toPosix(target)}（首次创建不要传 --update）`)
  }

  console.log(`[1/6] 迁移 staging → ${toPosix(target)}（${isUpdate ? '更新：合并 + 同步删除' : '新建'}）`)
  await copyInto(staging, target)
  if (isUpdate) {
    const removed = await syncRemoveStale(staging, target)
    console.log(`      同步删除过期文件：${removed} 个`)
  }

  const packageJson = path.join(target, 'package.json')
  if (await pathExists(packageJson)) {
    console.log('[2/6] 改写 link 路径 + CI 路径 + 依赖守卫')
    const changed = await rewriteHarnessLinks(packageJson, target, harness)
    console.log(`      改写 link: ${changed} 处`)
    await assertNoRegistryHarnessDeps(packageJson, harness)
  }
  await rewriteCiHarnessPaths(path.join(target, '.github', 'workflows', 'ci.yml'), target, harness)
  await ensureGitignore(target)

  console.log('[3/6] 目标目录 pnpm install + pnpm build')
  const config = {
    targetRoot,
    stagingRoot: path.dirname(staging),
    harnessRoot: harness,
    subagentProvider: 'spawn',
    maxChildDepth: 2,
    childTimeoutMs: 1_800_000,
    commitType: 'feat',
    push: false,
    gitAuthorName: 'csiroqa',
    gitAuthorEmail: 'justinwangyj@163.com',
    keepStaging: true,
    referenceRepos: [],
    stagingTtlDays: 0,
    installProfile: '',
  }
  const build = await verifyBuildInTarget(target, config)
  if (!build.ok) {
    throw new Error(`迁移后构建验证失败：${build.detail ?? '未知原因'}`)
  }
  console.log('      构建验证通过')

  console.log('[4/6] git init + add + diff + commit')
  await ensureGitRepo(target)
  const hasChanges = await stageAll(target)
  if (hasChanges) {
    await commitStaged(target, commitSubject, { name: config.gitAuthorName, email: config.gitAuthorEmail })
    console.log(`      已提交：${commitSubject}`)
  } else {
    console.log('      无暂存改动，跳过提交')
  }

  console.log('[5/6] 登记进 $DSH_HOME/plugin-forge.json')
  const migratedPath = toPosix(target)
  const { loadRegistry } = await import('../lib/index.js')
  const previous = (await loadRegistry()).repos.find((repo) => repo.path.toLowerCase() === migratedPath.toLowerCase())
  await upsertRepo({
    name,
    path: migratedPath,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    lastCommitAt: hasChanges ? new Date().toISOString() : previous?.lastCommitAt,
    commitCount: (previous?.commitCount ?? 0) + (hasChanges ? 1 : 0),
  })

  console.log('[6/6] 完成')
  console.log(JSON.stringify({ ok: true, name, migratedTo: migratedPath, committed: hasChanges, commitSubject }, null, 2))
  process.exit(0)
}

usage()
