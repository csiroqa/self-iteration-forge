/**
 * plugin-forge —— 真实 LLM 实例测试的宿主侧脚本。
 *
 * 两个模式：
 *   node scripts/llm-e2e-host.mjs prompt <name> <requirement> <stagingDir> <targetRoot> <harnessRoot>
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
  toPosix,
  upsertRepo,
  verifyBuildInTarget,
} from '../lib/index.js'

function usage() {
  console.error('用法（注意参数顺序，requirement 在最后）：')
  console.error('  node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> <requirement>')
  console.error('  node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> <commitSubject>')
  process.exit(2)
}

const [, , mode, name, stagingDir, targetRoot, harnessRoot, extra] = process.argv

if (mode === 'prompt') {
  if (name === undefined || stagingDir === undefined || targetRoot === undefined || harnessRoot === undefined || extra === undefined) usage()
  const promptText = buildChildPrompt({
    requirement: extra,
    name,
    mode: 'create',
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
  const staging = path.resolve(stagingDir)
  const target = path.resolve(targetRoot, name)
  const harness = path.resolve(harnessRoot)

  // 0. staging 校验。
  const files = await readdir(staging, { withFileTypes: true })
  if (files.length === 0) throw new Error(`staging 为空：${toPosix(staging)}`)
  if (await pathExists(target)) {
    throw new Error(`目标目录已存在：${toPosix(target)}（本脚本不做 update 合并，先人工确认）`)
  }

  console.log(`[1/6] 迁移 staging → ${toPosix(target)}`)
  await copyInto(staging, target)

  const packageJson = path.join(target, 'package.json')
  if (await pathExists(packageJson)) {
    console.log('[2/6] 改写 link 路径 + CI 路径 + 依赖守卫')
    const changed = await rewriteHarnessLinks(packageJson, staging, target, harness)
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
  }
  const build = await verifyBuildInTarget(target, config)
  if (build !== 'passed') {
    throw new Error(`迁移后构建验证失败：${build}`)
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
  await upsertRepo({
    name,
    path: migratedPath,
    createdAt: new Date().toISOString(),
    lastCommitAt: hasChanges ? new Date().toISOString() : undefined,
    commitCount: hasChanges ? 1 : 0,
  })

  console.log('[6/6] 完成')
  console.log(JSON.stringify({ ok: true, name, migratedTo: migratedPath, committed: hasChanges, commitSubject }, null, 2))
  process.exit(0)
}

usage()
