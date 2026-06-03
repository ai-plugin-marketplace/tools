# Embedding a marketplace in an existing software repo

Most marketplaces start from the [`template`](https://github.com/ai-plugin-marketplace/template) repo, where the **repo root _is_ the marketplace**. But you can also turn a repo whose primary purpose is shipping _software_ — a CLI, a library, a service — into a marketplace for the agent plugins that make that software easy to drive. The CLI and its agent skills then ship and version together.

This guide walks through that setup. It assumes you already have a software repo with a `package.json`.

> **When to use this vs. the template:** if you're starting fresh with _only_ plugins, fork the template (`aipm init`). Use this guide when plugins live alongside existing source you don't want to disturb.

## How it works

The toolkit normally assumes a fixed `plugins/` directory at the repo root and writes generated bundles to `dist/`. A real software repo often already owns those names. An optional **`aipm.repo.ts`** at the repo root relocates them:

```ts
// aipm.repo.ts
import { defineRepoConfig } from '@ai-plugin-marketplace/core';

export default defineRepoConfig({
  pluginsRoot: 'agent-plugins', // where your plugin folders live (default: 'plugins')
  distDir: 'agent-plugins/dist', // where generated bundles go (default: 'dist')
});
```

Both paths are **repo-root-relative** and must stay within the repo (no absolute paths, no `..`) — host platforms resolve a plugin's `source` relative to the repo root, so an escaping root would be unrepresentable. An invalid `aipm.repo.ts` surfaces as a `repo-config-invalid` validation finding rather than a crash.

What stays fixed are the things host platforms read by exact name: the per-target plugin manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, …) and the marketplace registries at the repo root (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`). `aipm.repo.ts` moves only _where your plugin sources live on disk_; the registry `source` entries are rewritten to point at the relocated root automatically.

## Steps

### 1. Add the toolkit as a dev dependency

```sh
pnpm add -D @ai-plugin-marketplace/cli @ai-plugin-marketplace/core
```

Optionally add scripts so contributors don't need to remember the binary:

```jsonc
// package.json
{
  "scripts": {
    "plugins:scaffold": "aipm scaffold",
    "plugins:build": "aipm build",
    "plugins:check": "aipm validate",
  },
}
```

### 2. Declare the relocated roots

Create `aipm.repo.ts` at the repo root (see [How it works](#how-it-works) above). Pick a `pluginsRoot` that doesn't collide with anything your software already uses — `agent-plugins/` is a good default.

> `aipm init` is for **greenfield** repos only; it refuses to write into a non-empty directory. For an existing repo, add `aipm.repo.ts` by hand as shown here. (A dedicated `aipm init --embedded` is planned.)

### 3. Scaffold a plugin

```sh
pnpm exec aipm scaffold unraid-diagnostics
```

This honors `pluginsRoot`, so it writes the plugin to `agent-plugins/unraid-diagnostics/` with skeleton per-target manifests, and **registers it in the marketplace registries at the repo root** with a repo-relative `source` (`./agent-plugins/unraid-diagnostics`). Scaffold only touches the registries for targets in the plugin's envelope.

By default a plugin declares all known targets. To scope it, edit the generated `agent-plugins/<name>/aipm.config.ts`:

```ts
import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '0.1.0',
  targets: ['claude', 'codex'], // claude | codex | cursor | gemini | kiro | vercel
});
```

### 4. Author your plugin

Fill in the conventional locations inside the plugin folder — `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/`, `.mcp.json`, and each target's manifest. These keep their conventional names _inside_ the (relocated) plugin folder, so they read naturally to agents authoring them. See the [`template`](https://github.com/ai-plugin-marketplace/template) repo for a worked plugin.

### 5. Add marketplace metadata

Scaffolding creates minimal registry files containing just the `plugins` array. Add the top-level metadata each host shows users — for example:

```jsonc
// .claude-plugin/marketplace.json  (and .cursor-plugin/marketplace.json)
{
  "name": "unraid-cli",
  "owner": { "name": "mike-north" },
  "metadata": { "description": "Agent plugins for the unraid-cli tool" },
  "plugins": [{ "name": "unraid-diagnostics", "source": "./agent-plugins/unraid-diagnostics" }],
}
```

```jsonc
// .agents/plugins/marketplace.json  (Codex)
{
  "name": "unraid-cli",
  "interface": { "displayName": "unraid-cli" },
  "plugins": [
    {
      "name": "unraid-diagnostics",
      "source": { "source": "local", "path": "./agent-plugins/unraid-diagnostics" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity",
    },
  ],
}
```

### 6. Build and validate

```sh
pnpm exec aipm build      # generate per-target artifacts and dist bundles
pnpm exec aipm validate   # check schemas, envelope adherence, and marketplace registration
```

Commit both your sources **and** the generated artifacts (CI enforces they stay in sync). Wire `aipm validate` into your existing CI alongside your software's tests.

### 7. Install from a host

Consumers add your repo as a marketplace and install plugins by name:

```sh
# Claude Code / Cursor
/plugin marketplace add <owner>/<repo>

# OpenAI Codex
codex plugin marketplace add <owner>/<repo>
```

Each host reads its own registry at the repo root and follows each plugin's `source` into the relocated `agent-plugins/` tree.

## Worked layout

```
unraid-cli/
├── src/ …                            # the CLI's own source (untouched)
├── plugins/                          # the CLI's OWN plugins, if any (untouched)
├── package.json                      # + @ai-plugin-marketplace/cli devDependency
├── aipm.repo.ts                      # pluginsRoot: 'agent-plugins'
├── .claude-plugin/marketplace.json   # registry (repo root)
├── .cursor-plugin/marketplace.json   # registry (repo root)
├── .agents/plugins/marketplace.json  # Codex registry (repo root)
└── agent-plugins/                    # relocated plugins root
    ├── unraid-diagnostics/
    │   ├── aipm.config.ts
    │   ├── .claude-plugin/plugin.json
    │   ├── .codex-plugin/plugin.json
    │   ├── skills/…/SKILL.md
    │   └── …
    └── dist/…                         # generated bundles (relocated distDir)
```

## Reference

- `defineRepoConfig` API: [`packages/core/docs/core.definerepoconfig.md`](../../packages/core/docs/core.definerepoconfig.md)
- Design rationale and constraints: [`docs/specs/embedded-marketplaces-and-codex-target.md`](../specs/embedded-marketplaces-and-codex-target.md)
- Toolkit architecture: [`docs/specs/architecture.md`](../specs/architecture.md)
