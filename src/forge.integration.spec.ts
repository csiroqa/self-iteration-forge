/**
 * plugin-forge —— 端到端集成测试。
 *
 * 注入假子代理（直接往 staging 写一个最小可构建插件），完整跑通
 * runForge 流水线：staging → 迁移 → link 改写 → 依赖守卫 → 目标目录
 * 真实 pnpm install + pnpm build → git init/add/diff/commit → 登记表。
 * 需要网络（pnpm install 从 registry 拉 tsdown/typescript）。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { runForge, type ForgeConfig, type StartChild } from './forge.ts'
import { loadRegistry } from './registry.ts'
import { findHarnessRoot, relativeLink, runCommand, toPosix } from './utils.ts'

/** 仓库根（本文件在 src/ 下）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

let tempRoot: string
let savedHome: string | undefined
let harnessRoot: string

/** 假子代理：在 staging 写入最小可构建插件，返回 completed + REPORT。 */
function fakeChild(options: {
  staging: string
  harnessRoot: string
  variation?: number
  removeFromStaging?: readonly string[]
  /** 模拟子代理检测到与已有插件重复：不写任何文件，REPORT 报告 duplicate_of。 */
  duplicateOf?: string
}): StartChild {
  return async () => {
    const { staging, harnessRoot: harness, variation = 1, removeFromStaging = [], duplicateOf } = options
    if (duplicateOf !== undefined) {
      // 重复检测路径：不开发任何文件。
      return {
        stopReason: 'completed' as const,
        text: [
          'REPORT_START',
          'plugin_name: demo-mini',
          'summary_zh: （重复，未开发）',
          'summary_en: duplicate detected, nothing built',
          'requires_client: false',
          'build: skipped',
          'typecheck: skipped',
          'test: skipped',
          'files: ',
          'notes: 检测到重复，未创建任何文件',
          `duplicate_of: ${duplicateOf}`,
          'duplicate_note: 与既有插件功能高度重叠（同为核心功能），无新增价值',
          'REPORT_END',
        ].join('\n'),
      }
    }
    await mkdir(path.join(staging, 'src'), { recursive: true })
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({
      name: '@dsh-external/demo-mini',
      version: '0.1.0',
      description: 'DSH 最小示例插件（forge 集成测试产物）',
      private: true,
      type: 'module',
      main: 'lib/index.js',
      scripts: { build: 'tsdown' },
      dependencies: {
        '@deepseek-ai/cordis': `link:${relativeLink(staging, path.join(harness, 'vendor/cordis'))}`,
      },
      devDependencies: {
        tsdown: '^0.22.14',
        typescript: '^5.9.3',
      },
    }, null, 2))
    await writeFile(path.join(staging, 'src', 'index.ts'), [
      '/** 最小示例插件。 */',
      "import type { Context } from '@deepseek-ai/cordis'",
      "export const name = 'demo-mini'",
      'export function apply(ctx: Context): void {',
      '  void ctx',
      '}',
      '',
    ].join('\n'))
    await writeFile(path.join(staging, 'tsdown.config.ts'), [
      "import type { UserConfig } from 'tsdown'",
      'const config: UserConfig = {',
      "  name: '@dsh-external/demo-mini',",
      "  entry: ['src/index.ts'],",
      "  outDir: 'lib',",
      "  format: ['esm'],",
      "  platform: 'node',",
      "  fixedExtension: false,",
      "  dts: true,",
      "  deps: { neverBundle: ['@deepseek-ai/cordis'] },",
      '}',
      'export default config',
      '',
    ].join('\n'))
    await writeFile(path.join(staging, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: demo-mini',
      "      name: '@dsh-external/demo-mini'",
      '',
    ].join('\n'))
    await writeFile(path.join(staging, 'README.md'), `# demo-mini\n\n最小示例插件（第 ${variation} 版）。\n`)
    if (variation === 1) {
      await writeFile(path.join(staging, 'legacy.txt'), 'will be removed on update\n')
    }
    // 更新模式下：模拟子代理按需求从交付目录删除文件（宿主应同步删除）。
    for (const rel of removeFromStaging) {
      await rm(path.join(staging, rel), { force: true })
    }
    const text = [
      'REPORT_START',
      'plugin_name: demo-mini',
      'summary_zh: 最小示例插件',
      'summary_en: add minimal demo plugin',
      'requires_client: false',
      'build: passed',
      'typecheck: passed',
      'test: none',
      'files: package.json, src/index.ts, tsdown.config.ts, cordis.patch.yml, README.md',
      'REPORT_END',
    ].join('\n')
    return { stopReason: 'completed' as const, text }
  }
}

function makeConfig(): ForgeConfig {
  return {
    targetRoot: path.join(tempRoot, 'forge-target'),
    stagingRoot: path.join(tempRoot, 'forge-staging'),
    harnessRoot,
    subagentProvider: 'spawn',
    maxChildDepth: 2,
    childTimeoutMs: 180_000,
    commitType: 'feat',
    push: false,
    gitAuthorName: 'Forge Test',
    gitAuthorEmail: 'forge@test.local',
    keepStaging: true,
    referenceRepos: [],
    stagingTtlDays: 0,
    installProfile: '',
  }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plugin-forge-e2e-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(tempRoot, 'dsh-home')
  harnessRoot = await findHarnessRoot(REPO_ROOT)
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  await rm(tempRoot, { recursive: true, force: true })
})

describe('runForge 端到端（假子代理 + 真实迁移/构建/git）', () => {
  it('完整流水线：迁移 → link 改写 → 构建验证 → 提交 → 登记', async () => {
    const config = makeConfig()
    const name = 'demo-mini'
    const staging = path.join(config.stagingRoot, name)
    const target = path.join(config.targetRoot, name)

    const result = await runForge({
      config,
      workspace: REPO_ROOT,
      harnessRoot,
      args: { requirement: '做一个最小示例插件', name, migrate: true, update: false },
      signal: new AbortController().signal,
      startChild: fakeChild({ staging, harnessRoot }),
    })

    // 结构化结果。
    expect(result.ok).toBe(true)
    expect(result.pluginName).toBe(name)
    expect(result.migratedTo).toBe(toPosix(target))
    expect(result.committed).toBe(true)
    expect(result.commitSubject).toBe('feat: demo-mini: add minimal demo plugin')
    expect(result.build).toBe('passed')
    expect(result.files).toContain('src/index.ts')
    // 防回归：返回值必须是无损 JSON（工具注册表会以此校验，undefined 字段会失败）。
    expect(snapshotJsonValue(result)).toBeDefined()

    // 迁移目录：link 已改写为目标深度。
    const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@deepseek-ai/cordis'])
      .toBe(`link:${relativeLink(target, path.join(harnessRoot, 'vendor/cordis'))}`)

    // 目标构建产物存在。
    await expect(stat(path.join(target, 'lib', 'index.js'))).resolves.toBeDefined()

    // git：仓库存在、提交 subject 正确、工作区干净。
    await expect(stat(path.join(target, '.git'))).resolves.toBeDefined()
    const log = await runCommand('git', ['log', '-1', '--format=%s'], { cwd: target })
    expect(log.stdout.trim()).toBe('feat: demo-mini: add minimal demo plugin')
    const status = await runCommand('git', ['status', '--porcelain'], { cwd: target })
    expect(status.stdout.trim()).toBe('')

    // 登记表：条目存在且提交计数为 1。
    const registry = await loadRegistry()
    expect(registry.repos).toHaveLength(1)
    expect(registry.repos[0]?.name).toBe(name)
    expect(registry.repos[0]?.commitCount).toBe(1)
  }, 240_000)

  it('update=true 时更新既有仓库、同步删除过期文件并累计提交次数', async () => {
    const config = makeConfig()
    const name = 'demo-mini'
    const staging = path.join(config.stagingRoot, name)
    const target = path.join(config.targetRoot, name)

    await runForge({
      config,
      workspace: REPO_ROOT,
      harnessRoot,
      args: { requirement: '做一个最小示例插件', name, migrate: true },
      signal: new AbortController().signal,
      startChild: fakeChild({ staging, harnessRoot, variation: 1 }),
    })
    // 第一次创建的仓库包含 legacy.txt。
    await expect(stat(path.join(target, 'legacy.txt'))).resolves.toBeDefined()

    // 第二次：更新既有仓库；子代理删除了 legacy.txt → 宿主应同步删除。
    const result = await runForge({
      config,
      workspace: REPO_ROOT,
      harnessRoot,
      args: { requirement: '更新示例插件', name, migrate: true, update: true },
      signal: new AbortController().signal,
      startChild: fakeChild({ staging, harnessRoot, variation: 2, removeFromStaging: ['legacy.txt'] }),
    })
    expect(result.committed).toBe(true)
    await expect(stat(path.join(target, 'legacy.txt'))).rejects.toThrow()

    const registry = await loadRegistry()
    expect(registry.repos).toHaveLength(1)
    expect(registry.repos[0]?.commitCount).toBe(2)

    const log = await runCommand('git', ['log', '--oneline'], { cwd: target })
    expect(log.stdout.trim().split(/\r?\n/)).toHaveLength(2)
  }, 240_000)

  it('目标目录已存在且未开 update 时拒绝（防误覆盖）', async () => {
    const config = makeConfig()
    const name = 'demo-mini'
    await mkdir(path.join(config.targetRoot, name), { recursive: true })
    await writeFile(path.join(config.targetRoot, name, 'keep.txt'), 'do not touch\n')

    await expect(runForge({
      config,
      workspace: REPO_ROOT,
      harnessRoot,
      args: { requirement: '做一个最小示例插件', name },
      signal: new AbortController().signal,
      // 目标存在检查发生在启动子代理之前，假子代理不应被调用。
      startChild: async () => { throw new Error('不应启动子代理') },
    })).rejects.toThrow(/目标目录已存在/)

    // 既有文件未被触碰。
    await expect(readFile(path.join(config.targetRoot, name, 'keep.txt'), 'utf8'))
      .resolves.toBe('do not touch\n')
  })

  it('子代理检测到与已有插件重复时拒绝新建（不重复造轮子）', async () => {
    const config = makeConfig()
    const name = 'demo-mini'
    const staging = path.join(config.stagingRoot, name)
    const target = path.join(config.targetRoot, name)

    const result = await runForge({
      config,
      workspace: REPO_ROOT,
      harnessRoot,
      args: { requirement: '做一个最小示例插件', name },
      signal: new AbortController().signal,
      startChild: fakeChild({ staging, harnessRoot, duplicateOf: 'existing-demo' }),
    })

    // 结构化结果：duplicated 且未迁移、未提交、未登记。
    expect(result.duplicated).toBe(true)
    expect(result.existingName).toBe('existing-demo')
    expect(result.ok).toBe(true)
    expect(result.migratedTo).toBeUndefined()
    // 防回归：duplicate 分支返回值同样必须是无损 JSON。
    expect(snapshotJsonValue(result)).toBeDefined()
    await expect(stat(target)).rejects.toThrow()
    const registry = await loadRegistry()
    expect(registry.repos).toHaveLength(0)
  })
})
