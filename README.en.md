# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

An AI-native DSH plugin generator. `forge_plugin` lets the AI judge capability gaps while executing tasks and generate plugins to fill them: a subagent builds the plugin → it is migrated to an independent git repo under the project root `/dsh-plugins/<name>` (committed on completion, English Conventional Commit) → hot-mounted into the current runtime.

中文: [README.md](README.md)

## Usage

AI calls `forge_plugin`:

| Param | Required | Description |
| --- | --- | --- |
| `requirement` | yes | Plugin requirement (Chinese preferred) |
| `name` | no | Repo name (kebab-case); auto-derived |
| `targetRoot` | no | Migration root; default project-root/dsh-plugins |
| `update` | no | Update an existing repo (default false) |
| `install` | no | Install into the profile (default false; requires installProfile) |
| `hot` | no | Hot-mount into the current runtime (default true) |

Pipeline: staging (workspace `/.forge-staging`) → subagent develops and verifies → migrate (link/CI path rewrite, dependency guards, load smoke) → git init/add/diff/commit → register in `$DSH_HOME/plugin-forge.json` → hot-mount.

`/forge status`: lists forged repos (HEAD, working-tree state, commit count).

## Avoiding duplicates

The guidance section does not inject the plugin list (saves context). The subagent self-checks before developing: it reads the registry and the `dsh-plugins` directory; if the requirement duplicates an existing plugin it reports `duplicate_of`, the host refuses to create a new repo and returns `existingName` — iterate with `update=true` instead.

## Config (cordis.patch.yml, all optional)

| Key | Default | Description |
| --- | --- | --- |
| `targetRoot` | empty | Migration root; empty = workspace parent/dsh-plugins |
| `stagingRoot` | empty | Staging root; empty = workspace/.forge-staging |
| `harnessRoot` | empty | deepseek-harness checkout root; empty = auto-discovered |
| `installProfile` | empty | Profile installed into on `install: true` |
| `commitType` | `feat` | Conventional Commit type |
| `push` | `false` | Whether to push after commit |
| `maxChildDepth` | `2` | Subagent delegation depth cap |
| `childTimeoutMs` | `2700000` | Subagent/build timeout |
| `keepStaging` | `true` | Keep staging for debugging |
| `stagingTtlDays` | `0` | Staging retention days; 0 = never clean |

## Install

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:D:\2-OGP\plugin-forge
```

Restart `dsh web`. Prerequisites: Node >= 22, pnpm, a local `deepseek-harness` checkout (deps are `link:`ed to `../deepseek-harness`).

## Quality gates

typecheck/test/build in staging → real rebuild in the target after migration → main/types existence check → reject registry-versioned `@deepseek-ai/*` deps → **load smoke** (run `apply` on a real cordis Context to catch "builds fine but crashes on boot" errors) → diff check before commit.

## Working with the repository mechanism

A home-level third-party mechanism (plugin-console, `repository-plugins.repositories` in `$DSH_HOME/cordis.patch.yml`) manages remote plugin sources as panel lines: add = install, update = lock to the latest remote commit, delete = uninstall, edits take effect immediately. Line format `github:owner/repo#ref` (`&path:/packages/<subpkg>` for monorepos). Forge products are single-package independent repos — push to GitHub and add directly as a source; later `update=true` iterations are picked up by the panel's update.

Three delivery methods: hot-mount (default, current session) / install (profile, after restart) / repository source (home level, formal distribution).

## Real-LLM testing (no GUI restart needed)

`scripts/llm-e2e-host.mjs`: `prompt` generates the real subagent prompt, `run` executes the host-side pipeline (migration/link+CI rewrite/build/git commit/register; `--update` for updates). The example passes an explicit `targetRoot` to demonstrate the override.

```sh
node scripts/llm-e2e-host.mjs prompt <name> <stagingDir> <targetRoot> <harnessRoot> "<requirement>"
node scripts/llm-e2e-host.mjs run <name> <stagingDir> <targetRoot> <harnessRoot> "feat: <name>: <summary>"
```

## Security

- forge spawns subagents, runs networked `pnpm install`, builds in the target, and executes `git commit` — only pass requirements you trust
- Diff checked before commit, `.gitignore` backstop, no automatic push/tag/release
- Subagents may only write inside staging (within the workspace)
