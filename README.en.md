# dsh-plugin-forge

[![CI](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-plugin-forge/actions/workflows/ci.yml)

A **plugin forge** for DeepSeek Harness (DSH): exposes the `forge_plugin` tool so an AI can pass a requirement and spawn a fresh agent that builds a DSH plugin following the toolchain/format/language conventions of the sibling plugin repos (plus the user's global AGENTS.md rules), verifies the build, migrates it into an independent git repository under the **project root (parent of the caller workspace) `/dsh-plugins/<name>`**, and commits immediately once the feature is complete (event-driven, not timer-based). Repos are registered in `$DSH_HOME/plugin-forge.json`; `/forge status` lists them.

中文: [README.md](README.md)

## AI-native design principle (core positioning)

plugin-forge is not a "tool for users to operate" — it is an **AI-native self-iteration infrastructure** where the AI is the subject of the flow and humans only express needs naturally:

- **Autonomous AI loop**: discover gaps (self-judging "what is missing, what to add" while executing tasks) → decide (worth fixing, right size) → deliver (subagent development + automated verification) → iterate (`update=true`, automatic duplicate detection so wheels are never reinvented) → use (hot-mounted by default, usable in the current session) — no human mention of "plugin", no panel operations, no restart required
- **Zero manual ops**: quality defenses (staging build verification + real rebuild after migration + dependency guards + **load smoke**) and registration (`/forge status`) and cleanup (staging TTL) are all automated
- **Human involvement (deliberately minimal)**: a one-time restart to load plugin-forge itself; optional config (`targetRoot`/`installProfile`); formal external distribution (push to GitHub, install via a repository source)

## Features

### `forge_plugin` tool (AI-callable)

| Param | Required | Description |
| --- | --- | --- |
| `requirement` | yes | Plugin requirement (Chinese preferred): features, behavior, interaction, config |
| `name` | no | Plugin/repo directory name (kebab-case); auto-derived from the requirement when omitted |
| `targetRoot` | no | Root directory for independent repos; defaults to the configured `targetRoot` (default: project root (parent of the caller workspace) `/dsh-plugins`) |
| `migrate` | no | Whether to migrate into an independent git repo and commit (default `true`) |
| `update` | no | Whether updating an existing target directory is allowed (default `false`, prevents accidental overwrite) |
| `install` | no | Whether to auto-install into the profile after migration+commit (default `false`; requires `installProfile` config; takes effect after restart) |
| `hot` | no | Whether to hot-mount into the current runtime (default `true`: auto-mounted after generation, the session gains the new tool/command immediately; pass `false` to disable) |

Pipeline:

1. Clean and recreate the staging directory (inside the caller session's workspace, `/.forge-staging/<name>`)
2. Spawn a fresh subagent (`spawn` provider, `maxChildDepth=2` — one more delegation level, capped against recursion); the prompt embeds the requirement, sibling-repo conventions (tsdown dual-half build, pnpm@11.7.0, strict TypeScript, `cordis.patch.yml` insert rows, bilingual READMEs, LICENSE/CI), the user's AGENTS.md rules, and environment constraints (staging-only writes, network for `pnpm install`, `--store-dir` / `--ignore-scripts` fallbacks)
3. On `completed`, copy staging into `targetRoot/<name>`: rewrite deepseek-harness `link:` deps to the correct relative paths, idempotently ensure `.gitignore`, and re-run `pnpm install && pnpm build` in the target to verify the migration
4. **Commit on completion**: `git init` (if needed) → `git add -A` → check diff → commit once with an English Conventional Commit message (e.g. `feat: web-search-memo: add keyword search for session memos`); no push unless explicitly configured
5. Register the repo in `$DSH_HOME/plugin-forge.json` (atomic write)

### `/forge status`

Lists forge-created repos inside the chat: name, path, **HEAD commit, whether the working tree is clean**, last commit time, commit count.

## Updating an existing plugin

Call `forge_plugin` again with `update: true` to update an existing repo (updates are rejected without `update: true` to prevent accidental overwrites):

- The host **pre-fills staging** with the current repo sources, so the child agent only makes incremental changes instead of re-reading/re-writing every file
- Files the child removes from the staging directory are **synced out of the target repo** during migration (no leftovers)
- The update is committed immediately and the commit count is incremented

## Self-iteration: agents call the forge spontaneously (full loop)

The plugin registers a **self-iteration guidance section** in the system prompt defining the complete loop:

1. **Discover (self-discovery while executing)**: while carrying out a user task, the LLM itself judges that it lacks the capability needed to finish the job (tool/command/automation gap), is stuck doing repetitive manual work, or that a feature is worth fixing as a plugin (recurring, cross-session reuse) and fits as a single lightweight plugin; **the AI decides what is missing and what to add — no plugin mention from the user required**
2. **Call spontaneously**: proactively call `forge_plugin` instead of only giving advice (no explicit "build a plugin" request required)
3. **Deliver**: a subagent develops → build verified → migrated to an independent repo → committed on completion
4. **Seamless switch (hot-mount by default)**: the plugin is hot-mounted into the current runtime automatically — the session gains the new capability immediately (no restart); pass `install: true` as well to persist across restarts

**No wheel reinvention (zero context overhead)**: the guidance section does not inject the existing-plugin list (saves tokens) — instead the **forge subagent self-checks before developing**: it reads `$DSH_HOME/plugin-forge.json` (with Chinese summaries) and the target root directory; if the requirement duplicates/highly overlaps an existing plugin, it builds nothing and reports `duplicate_of` in the REPORT, the host refuses to create a new repo and returns `existingName`, and the caller iterates with `update=true` instead.

## Self-iteration workflow example (design intent)

```text
You: build a plugin that auto-archives each session to a local folder when it ends
AI: calls forge_plugin(requirement=..., name="session-auto-archive")
  → a fresh agent develops, verifies the build, migrates to project-root/dsh-plugins/session-auto-archive, commits
  → returns: repo path + commit summary
You: add a system notification after archiving in session-auto-archive
AI: calls forge_plugin(requirement=..., name="session-auto-archive", update=true)
  → pre-fills existing code → incremental changes → sync deletion → commits again
```

Every completed feature becomes a revertible commit; the depth cap (`maxChildDepth=2`) keeps iteration controlled.

## Quality guards (migration defenses)

- Child-agent build verification in staging (`typecheck` / `test` / `build`)
- Re-run `pnpm install && pnpm build` in the target after migration
- Verify that `main` / `types` declared in `package.json` actually exist after the build (prevents `.mjs`/declaration mismatches)
- Reject `@deepseek-ai/*` deps written as registry versions (must be `link:`ed to the local deepseek-harness checkout)
- Idempotently ensure `.gitignore`; diff checked before commit; commit subjects cleaned to Conventional Commits ≤72 chars

## Configuration

All keys are optional (defaults live in `src/index.ts`):

| Key | Default | Description |
| --- | --- | --- |
| `targetRoot` | empty | Root directory for independent repos; empty = project root (parent of the caller workspace) `/dsh-plugins` |
| `stagingRoot` | empty | Staging root; empty = caller workspace `/.forge-staging` |
| `harnessRoot` | empty | deepseek-harness checkout root; empty = auto-discovered upward from the workspace |
| `subagentProvider` | `spawn` | Subagent provider name (built into the base bundle) |
| `maxChildDepth` | `2` | Maximum child delegation depth (recursion cap) |
| `childTimeoutMs` | `2700000` | Child/target-build timeout in ms (45 min) |
| `commitType` | `feat` | Conventional Commit type |
| `push` | `false` | Whether to push after commit (off by default) |
| `gitAuthorName` / `gitAuthorEmail` | `csiroqa` / `justinwangyj@163.com` | Fallback author identity when the repo has none configured |
| `keepStaging` | `true` | Keep the staging directory after success (easier debugging) |
| `referenceRepos` | 4 sibling repos | Reference repos listed in the child prompt (toolchain/format/style) |
| `stagingTtlDays` | `0` | Staging retention days; older staging dirs are cleaned on the next forge call; `0` = never clean |
| `installProfile` | empty | Profile to auto-install into after migration+commit (e.g. `web`); empty = never (off by default) |

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
3. Generated plugins live at the project root (parent of the caller workspace) `/dsh-plugins/<name>` and can be installed like any sibling plugin: `dsh plugin --profile web add link:<project-root>/dsh-plugins/<name>`

## Working with the Repository plugin mechanism (plugin-console)

DSH also has a **home-level Repository plugin mechanism** (third-party `@dsh-external/plugin-console` + `repository-plugins.repositories` in `$DSH_HOME/cordis.patch.yml`, not built into DSH core): the plugin panel manages remote plugin sources as lines — **adding a line installs, updating locks to the latest remote commit, deleting a line uninstalls, and edits take effect immediately without restart**. Line format:

```text
github:owner/repo#ref                          # single-package repo
github:owner/repo#ref&path:/packages/<subpkg>  # monorepo subpackage
```

How forge products fit in:

1. Every forge-generated plugin is an **independent git repo** (`/dsh-plugins/<name>`, committed on completion) with a single-package layout — push it to GitHub and add it directly as a repository source (no `&path:` needed)
2. After iterating with `forge_plugin(update=true)` and pushing, the panel's "update" locks to the latest commit
3. Delivery methods compared:

| Method | Effective | Use case |
| --- | --- | --- |
| hot-mount (default) | immediately, current instance | default delivery: usable right after generation (`hot: false` disables) |
| `install: true` (profile) | after restart | local persistence in the profile |
| repository line (plugin-console) | immediately, home level | formal distribution with a GitHub remote |

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
