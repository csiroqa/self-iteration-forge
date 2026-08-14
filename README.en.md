# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

A **plugin forge** for DeepSeek Harness (DSH): exposes the `forge_plugin` tool so an AI can pass a requirement and spawn a fresh agent that builds a DSH plugin following the toolchain/format/language conventions of the sibling plugin repos (plus the user's global AGENTS.md rules), verifies the build, migrates it into an independent git repository under `D:/2-OGP`, and commits immediately once the feature is complete (event-driven, not timer-based). Repos are registered in `$DSH_HOME/plugin-forge.json`; `/forge status` lists them.

中文: [README.md](README.md)

## Features

### `forge_plugin` tool (AI-callable)

| Param | Required | Description |
| --- | --- | --- |
| `requirement` | yes | Plugin requirement (Chinese preferred): features, behavior, interaction, config |
| `name` | no | Plugin/repo directory name (kebab-case); auto-derived from the requirement when omitted |
| `targetRoot` | no | Root directory for independent repos; defaults to the configured `targetRoot` (`D:/2-OGP`) |
| `migrate` | no | Whether to migrate into an independent git repo and commit (default `true`) |
| `update` | no | Whether updating an existing target directory is allowed (default `false`, prevents accidental overwrite) |

Pipeline:

1. Clean and recreate the staging directory (inside the caller session's workspace, `/.forge-staging/<name>`)
2. Spawn a fresh subagent (`spawn` provider, `maxChildDepth=2` — one more delegation level, capped against recursion); the prompt embeds the requirement, sibling-repo conventions (tsdown dual-half build, pnpm@11.7.0, strict TypeScript, `cordis.patch.yml` insert rows, bilingual READMEs, LICENSE/CI), the user's AGENTS.md rules, and environment constraints (staging-only writes, network for `pnpm install`, `--store-dir` / `--ignore-scripts` fallbacks)
3. On `completed`, copy staging into `targetRoot/<name>`: rewrite deepseek-harness `link:` deps to the correct relative paths, idempotently ensure `.gitignore`, and re-run `pnpm install && pnpm build` in the target to verify the migration
4. **Commit on completion**: `git init` (if needed) → `git add -A` → check diff → commit once with an English Conventional Commit message (e.g. `feat: web-search-memo: add keyword search for session memos`); no push unless explicitly configured
5. Register the repo in `$DSH_HOME/plugin-forge.json` (atomic write)

### `/forge status`

Lists forge-created repos inside the chat: name, path, last commit time, commit count.

## Configuration

All keys are optional (defaults live in `src/index.ts`):

| Key | Default | Description |
| --- | --- | --- |
| `targetRoot` | `D:/2-OGP` | Root directory for independent repos |
| `stagingRoot` | empty | Staging root; empty = caller workspace `/.forge-staging` |
| `harnessRoot` | empty | deepseek-harness checkout root; empty = auto-discovered upward from the workspace |
| `subagentProvider` | `spawn` | Subagent provider name (built into the base bundle) |
| `maxChildDepth` | `2` | Maximum child delegation depth (recursion cap) |
| `childTimeoutMs` | `2700000` | Child/target-build timeout in ms (45 min) |
| `commitType` | `feat` | Conventional Commit type |
| `push` | `false` | Whether to push after commit (off by default) |
| `gitAuthorName` / `gitAuthorEmail` | `csiroqa` / `justinwangyj@163.com` | Fallback author identity when the repo has none configured |
| `keepStaging` | `true` | Keep the staging directory after success (easier debugging) |

## Install

Prerequisites: Node.js >= 22, pnpm, a local `deepseek-harness` checkout (deps are `link:`ed to `../deepseek-harness`).

```sh
git clone https://github.com/csiroqa/dsh-plugin-forge.git
cd dsh-plugin-forge
pnpm install
pnpm build

# Install into the web profile (link: to this directory)
dsh plugin --profile web add link:$(pwd)        # POSIX
dsh plugin --profile web add link:D:\2-OGP\plugin-forge   # Windows
```

Restart `dsh web`, then hard-refresh the browser (**Ctrl+F5**).

## Usage

1. Ask the AI for a plugin in the chat; it will call `forge_plugin` (or explicitly request the call)
2. Run `/forge status` to list created repos and their last commits
3. Generated plugins live at `D:/2-OGP/<name>` and can be installed like any sibling plugin: `dsh plugin --profile web add link:D:/2-OGP/<name>`

## Design intent: agent self-iteration

This is the starting point of a self-iteration loop for DSH agents: an agent can generate/update plugins on demand to extend DSH itself, and every completed feature becomes a reviewable, revertible commit. The depth cap (`maxChildDepth=2`) and event-driven commits keep iteration controlled and auditable.

## Security

- `forge_plugin` spawns a subagent, runs `pnpm install` (network access to the npm registry), builds in the target directory, and executes `git commit` — real host operations; only pass requirements you trust
- Commits follow AGENTS.md: diff checked first, no sensitive files (`.gitignore` as backstop), no automatic push/tag/release
- The subagent may only write inside the staging directory (within the workspace)

## Compatibility

- **Platforms**: Windows / macOS / Linux (Node >= 22), verified by a three-OS CI matrix
- Developed against a DSH `0.1.0-rc.5`+ source checkout
- Build artifact: `tsdown` host half `lib/index.js` (standard Node ESM)

## License

**MIT License** (see [LICENSE](LICENSE)).

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Sibling plugins: [dsh-schedule](https://github.com/csiroqa/dsh-schedule), [dsh-hotkeys](https://github.com/csiroqa/dsh-hotkeys), [dsh-archive-viewer](https://github.com/csiroqa/dsh-archive-viewer)
