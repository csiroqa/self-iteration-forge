/**
 * plugin-forge — DSH 插件锻造厂。
 *
 * 纯 host 半区插件（无浏览器 UI）：构建产出
 *  - lib/index.js   host 半区（Node ESM：forge_plugin 工具 + /forge status 命令）
 *
 * 依赖约定（与姐妹仓库一致）：所有 @deepseek-ai/* 运行时依赖由插件安装后
 * 自带的 node_modules 提供（link: 指向本机 deepseek-harness 检出的构建产物），
 * 绝不内联。
 */
import type { UserConfig } from 'tsdown'

/** 本插件包名。 */
const ID = '@dsh-external/plugin-forge'

/** host 半区运行时值依赖（不内联）。 */
const HOST_RUNTIME_DEPS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

const libConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  // 保持入口文件名：src/index.ts → lib/index.js（package.json main 指向它）。
  fixedExtension: false,
  dts: true,
  clean: false,
  deps: {
    neverBundle: HOST_RUNTIME_DEPS,
  },
}

export default libConfig
