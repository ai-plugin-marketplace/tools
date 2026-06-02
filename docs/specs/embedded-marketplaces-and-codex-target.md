# Design Exploration: Embedded Marketplaces & the Codex Target

> **Status:** design exploration (no implementation). Scoping decisions captured with the maintainer: skills remain **hand-authored** (no CLI introspection), a repo may expose **multiple plugins**, the layout uses **conventional locations by default** with a **path-remapping / conflict-resolution affordance** for collisions with the host software, and **Codex is added as a new target**.
>
> **Two workstreams, mostly orthogonal:** (A) **Embedded marketplaces** — let a software repo host a marketplace without colliding with its own layout. (B) **Codex target** — add OpenAI Codex as a 6th host platform. They compose: Codex is a third *in-place marketplace* target, so it participates in the embedded design exactly like Claude/Cursor.

## Context

Today the `@ai-plugin-marketplace` toolkit (the `aipm` CLI in this repo) and the companion `template` repo embody a **dedicated-marketplace** model: the repo *root is* the marketplace. `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` sit at the repo root and register plugins via `source: ./plugins/<name>`; each plugin folder carries its own per-target manifests and content dirs (`skills/`, `agents/`, `commands/`, `hooks/`, `rules/`, `steering/`, `GEMINI.md`, `POWER.md`). You fork `template`, drop plugins under `plugins/`, and `aipm build`/`validate` operate on the repo root.

The new goal flips that assumption. A repo whose **primary purpose is shipping software** — e.g. [`mike-north/unraid-cli`](https://github.com/mike-north/unraid-cli) — should *also* act as a marketplace for the agent skills that operate that software, so the CLI and the agent skills that make it easy to drive ship and version together. The blocker is that the toolkit hard-codes "repo root == marketplace root" and a fixed `plugins/` directory, which collides with a real software repo's own layout (a CLI may literally already own `plugins/`, `commands/`, `docs/`, `dist/`).

The intended outcome: a software repo can host one or more hand-authored agent plugins in **conventional locations by default** (so agents author them well), while offering an escape hatch to **relocate** the plugin/marketplace source when it would collide with the host software — without changing the **canonical names the host platforms consume**.

## The load-bearing constraint (verify before building)

How Claude Code / Cursor consume a marketplace from a GitHub repo bounds what can move:

- The host reads the registry at a **fixed repo-root-relative path** (`.claude-plugin/marketplace.json`, Cursor at `.cursor-plugin/marketplace.json`). **This path is hard-pinned** — it can't be relocated into a subdir, because that's the only place the client looks.
- Each `plugins[].source` is a **relative path the client follows**, so it is **freely remappable** (`./plugins/x` → `./agent-plugins/x`). This is the entire mechanism that makes relocating the plugins root safe.
- Per-plugin manifest **filenames** are pinned (read by exact name), but their **containing directory moves freely** with the plugin source.
- **Gemini / Kiro** are consumed from wholly-generated `dist/<target>/<plugin>/` bundles the toolkit owns end-to-end, so their authoring source and `distRoot` can move freely; only the bundle's internal shape is fixed.

**Open question to confirm first:** whether the host resolves `source` relative to the **repo root** or to the **marketplace.json directory**, and whether `..`-prefixed sources are accepted. The existing `template` (`source: ./plugins/skill-evaluator`, marketplace.json one level down in `.claude-plugin/`) only works because the validator normalizes against repo root — strongly implying the host also resolves against repo root. **Codex's published rule confirms this for at least one target:** plugin `source.path` uses a `./` prefix, resolves **relative to the repo/marketplace root**, and must **stay within it** (no `..`). The design assumes **repo-root-relative, no `..`**; still worth confirming Claude Code / Cursor behavior before implementation, but Codex makes "keep `pluginsRoot` under the repo root" a hard rule rather than a recommendation.

## Where the topology is hard-coded today

Almost all topology knowledge funnels through a few spots — a clean seam:

- `packages/core/src/pipeline/discover.ts` — the only topology resolver. Hard-codes `path.join(root, 'plugins')` and `<root>/dist`. Everything downstream consumes its opaque `Discovery { repoRoot, distDir, pluginDirs }`.
- `packages/core/src/pipeline/validate.ts` — `validateMarketplaceRegistration` hard-codes the two registry paths and the expected `source` literal `./plugins/<name>`.
- `packages/core/src/pipeline/init.ts` + `init-template.ts` — greenfield only; `runInit` refuses any non-empty directory and writes a whole consumer repo.
- `packages/core/src/pipeline/operations.ts` (scaffold) and `packages/cli/src/run.ts` (`resolvePluginDir`) — hard-code `<cwd>/plugins/...`.
- `packages/core/src/config.ts` — `defineConfig`/`aipm.config.ts` is **per-plugin only** (`{ version, targets }`); there is **no repo-level config** anywhere. Marketplace metadata (`name`/`owner`/`description`) lives only as untyped JSON inside `marketplace.json`.

## Adding Codex as a target (net-new — not supported today)

Verified: there is **no Codex support**. `TargetId = 'claude' | 'cursor' | 'gemini' | 'kiro' | 'vercel'` (`packages/core/src/pipeline/types.ts:16`); `packages/core/src/targets/` has only `claude`, `cursor`, `gemini`, `kiro`, `vercel`; zero `codex` references in `packages/*/src`.

**Good news: Codex's plugin model is a near-clone of Claude Code's** (it even ships `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` back-compat env vars). So the Codex target is largely a **copy of the `claude` target with renamed paths**, not a from-scratch design. Codex conventions (mid-2026, from developers.openai.com/codex):

| Concept | Codex location/format | Claude analog | Mapping |
|---|---|---|---|
| Plugin manifest | `.codex-plugin/plugin.json` (name, version, description, author, `skills`/`mcpServers`/`apps`/`hooks` path fields, `interface{}`) | `.claude-plugin/plugin.json` | New `codex` Zod schema, ~clone of claude's |
| Skills | `skills/<name>/SKILL.md` (`name`/`description` frontmatter) | identical | Reuse as-is |
| Hooks | `hooks/hooks.json` (PreToolUse/PostToolUse/SessionStart/… + `matcher`/`command`; `${PLUGIN_ROOT}`) | `hooks/claude.json` (same shape); template already emits `hooks/hooks.json` for "Cursor/others" | Reuse existing `hooks/hooks.json` generation |
| MCP servers | `.mcp.json` (`{name:{command,args,env}}` or `url`/`bearer_token_env_var`) | `.mcp.json` | Reuse |
| Subagents | standalone TOML in `.codex/agents/*.toml` (`name`/`description`/`developer_instructions` + optional model/mcp_servers) | `agents/*.md` frontmatter | New transform: agent `.md` → `.codex/agents/*.toml` |
| Commands/prompts | custom slash-command prompts | `commands/*.md` | Map commands → Codex prompts (format TBD via `/codex/cli/slash-commands`) |
| Context file | `AGENTS.md` (hierarchical, override/fallback chain) | `GEMINI.md` / CLAUDE.md | New context file `AGENTS.md` |
| **Repo marketplace** | `.agents/plugins/marketplace.json` — `{name, interface{displayName}, plugins:[{name, source:{source:"local",path:"./plugins/<n>"}, policy:{installation,authentication}, category}]}` | `.claude-plugin/marketplace.json` | **Third in-place registry** the toolkit emits/validates |
| Install | `codex plugin marketplace add owner/repo` (in-place GitHub) | `/plugin marketplace add owner/repo` | Same in-place model |

**Consumption class: Codex is an *in-place marketplace* target like Claude/Cursor — NOT a `dist/` bundle target like Gemini/Kiro.** So it mirrors the `claude`/`cursor` target modules (no `bundle.ts`).

**Touch points to register the 6th target** (grounded in the code): add `'codex'` to the `TargetId` union, the `TARGET_IDS` tuple, and the `_targetIdsAreExhaustive` guard (`packages/core/src/pipeline/types.ts:16-42`); create `packages/core/src/targets/codex/{schemas,scaffold,validate,transform}.ts` (clone of `claude/`, no `bundle.ts`); wire it into the per-target dispatch in `build.ts`, `validate.ts`, `operations.ts`/`scaffold.ts`, and `cli/src/run.ts`; add the third marketplace registry to `validateMarketplaceRegistration` and to `init-template.ts`; add scaffold templates (`.codex-plugin/plugin.json`, `AGENTS.md`); update fixtures/tests that enumerate all targets (`scaffold.test.ts` already iterates `TARGET_IDS`, and `test-support/` fixtures) and the `dist/**` freshness oracle.

**Caveats / TBD:** the Codex marketplace entry schema is richer than Claude's (`policy.installation`, `policy.authentication`, `category` are required per plugin) — the registry generator/validator must supply these. The custom-prompt file format for `commands/` mapping wasn't fully documented (page at `/codex/cli/slash-commands`); confirm before implementing the commands→prompts transform. Codex's `interface{}` manifest block (displayName, category, logo, screenshots, …) is optional and can default from existing manifest fields.

## Path classes (the mental model)

The conflict-resolution affordance rests on classifying every path:

| Class | Examples | Remappable? | Why |
|---|---|---|---|
| **Authoring roots** | plugins root, dist root | Freely remappable | Only the toolkit reads these. |
| **Consumption-pinned** | Claude/Cursor/Codex registry locations (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`); per-target manifest *filenames* (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `POWER.md`) | Hard-pinned | Host reads them at a fixed name/location. Toolkit must emit canonical names here regardless of authoring layout. |
| **Generated bundles** | `dist/gemini/<plugin>`, `dist/kiro/<plugin>` | Root remappable, internal shape fixed | Consumed from a toolkit-owned bundle. |

**Invariant:** remapping moves *where source lives on disk*; it never changes a plugin's `name`, its manifest filenames, or the plugin-name segment of `source`. Only the **root prefix** of `source` changes.

## Recommended approach: phased, conventions-as-defaults

The two explored approaches sit on a spectrum. The recommendation is to ship the **minimal core first** (it unblocks `unraid-cli` immediately and is fully backward compatible), then grow into the **typed workspace + validated conflict-resolution** end-state, because the requirement explicitly asks for a *real, validated* collision affordance and multi-plugin support.

### Phase 1 — Relocatable roots (minimal, unblocks the use case)

Add an **optional repo-level config** read by `discover.ts`. Smallest viable surface:

```ts
// aipm.repo.ts at the software-repo root (optional; absent == today's behavior)
export interface AipmRepoConfigInput {
  pluginsRoot?: string;   // repo-relative; default 'plugins'
  distDir?: string;       // repo-relative; default 'dist'
}
```

- Load it in `discover.ts` (reuse the jiti machinery already in `load-config.ts`); treat the file's *presence* as the repo-root signal so an empty/not-yet-created plugins dir still resolves correctly; replace the two hard-coded joins with config values.
- In `validateMarketplaceRegistration`, compute the expected `source` as `./` + `path.relative(repoRoot, pluginDir)` instead of the literal `./plugins/<name>` (a no-op for the existing template), and fix the `./plugins/<name>` hint strings.
- Point `operations.ts#scaffold` and `run.ts#resolvePluginDir` at the configured plugins root.
- Add one additive `FindingCode`: `repo-config-invalid` (parallels `envelope-invalid`).

This solves the **most likely collision** — the host repo already owns top-level `plugins/`/`dist/` — by relocating the whole aipm subtree in one declaration (e.g. `pluginsRoot: 'agent-plugins'`), while preserving the conventional layout *inside* each plugin folder. It is backward compatible by construction: no `aipm.repo.ts` → byte-identical to today, so `template` keeps building.

**What Phase 1 does NOT solve:** per-plugin / per-subdir remapping; relocating the registry file itself; typed marketplace metadata; validated refusal of illegal remaps; an additive `init` for existing repos.

### Phase 2 — Typed workspace + validated conflict resolution (end-state)

Promote the repo config to a first-class **`aipm.workspace.ts` / `defineWorkspace`** (sibling to `defineConfig`, branded + `.strict()` Zod, exported from `index.ts`):

```ts
// aipm.workspace.ts at repo root
export default defineWorkspace({
  marketplace: { name: 'unraid-cli', owner: { name: 'mike-north' },
                 description: 'Agent plugins for the unraid-cli tool' },
  mode: 'embedded',              // 'dedicated' | 'embedded'; default 'dedicated'
  pluginsRoot: 'agent-plugins',  // remapped — repo already owns plugins/
  distRoot: 'agent-plugins/dist',
  paths: {                       // sparse overrides; only collisions
    claude: { marketplace: '.claude-plugin/marketplace.json' }, // pinned (see constraint)
    cursor: { marketplace: '.cursor-plugin/marketplace.json' },
    codex:  { marketplace: '.agents/plugins/marketplace.json' }, // pinned
  },
});
```

- Introduce a resolved **`Layout`** object (`{ repoRoot, mode, pluginsRoot, distRoot, marketplace, marketplacePaths: { target: { abs, pinned } } }`) produced once by `resolveLayout()` and threaded through `Discovery` to build/validate — collapsing topology from 5 call sites to one. Unspecified fields fall back to conventions; no workspace file at all → fully-defaulted layout == today.
- Marketplace metadata gets a typed home; the toolkit can *generate* the registry header instead of hand-maintaining JSON.
- New findings encode pinned-vs-remappable as validated errors (additive, MINOR-compatible):
  - `workspace-invalid` — config fails to load/validate.
  - `path-collision` (hard) — in embedded mode, the plugins/dist root overlaps foreign host content; steers the author to remap. **This is the conflict-resolution affordance.**
  - `mapping-invalid` (hard) — an override points outside the repo, tries to move a *pinned* path (e.g. Claude's registry off-root), or two plugins resolve to the same dir.
- Add `aipm init --embedded`: additive (never clobbers), collision-probes for non-colliding `pluginsRoot`/`distRoot`, writes `aipm.workspace.ts` + empty root registries + `<pluginsRoot>/.gitkeep`, leaves the host `package.json` alone (prints guidance / additive `scripts` merge), and writes CI as a non-colliding `.github/workflows/aipm.yml`.

`build.ts` needs **no structural change** — `computeDistBundles` already takes `distDir`, and in-plugin hook artifacts already write relative to the plugin dir, so both move with the layout for free.

### Worked example — `unraid-cli` (repo already owns `plugins/`)

```
unraid-cli/
├── src/ ...                         # the CLI's own source (untouched)
├── plugins/                         # the CLI's OWN plugins (host-owned, untouched)
├── aipm.workspace.ts                # mode: embedded, pluginsRoot: agent-plugins, targets incl. codex
├── .claude-plugin/marketplace.json  # PINNED at root; entries source: ./agent-plugins/<name>
├── .cursor-plugin/marketplace.json  # PINNED at root
├── .agents/plugins/marketplace.json # PINNED — Codex registry; source.path: ./agent-plugins/<name>
└── agent-plugins/                   # remapped aipm plugins root (collision avoided)
    ├── unraid-diagnostics/          # conventional layout INSIDE each plugin
    │   ├── aipm.config.ts
    │   ├── .claude-plugin/plugin.json
    │   ├── .codex-plugin/plugin.json
    │   ├── skills/.../SKILL.md
    │   ├── commands/  agents/  hooks/claude.yaml(→claude.json + hooks.json)
    │   └── AGENTS.md  GEMINI.md  ...
    ├── unraid-shares/               # second plugin (multi-plugin marketplace)
    └── dist/gemini|kiro/<plugin>/   # remapped distRoot bundles
```

Users install per host: `/plugin marketplace add mike-north/unraid-cli` (Claude/Cursor) or `codex plugin marketplace add mike-north/unraid-cli` (Codex). Each host reads its own pinned registry at the repo root and follows each `source` into `./agent-plugins/<name>`.

## Trade-offs

- **Phase 1 only:** tiny diff (~1 new loader, ~15 LOC in `discover.ts`, one validator tweak, one finding). Unblocks the headline use case. But cannot express pinned-path refusal, has no typed marketplace metadata, and no assisted `init` for existing repos — collisions inside a plugin folder and illegal remaps go undetected.
- **Phase 2:** adds public API surface (`defineWorkspace` + types — each a versioned contract), a second jiti config loader to test, `Discovery`-threading churn across build/validate/tests, and fuzzy collision heuristics that need careful messaging. In return: single source of topology truth, typed metadata, *validated* conflict resolution (the actual safety property the embedded case needs), and dedicated/embedded unified as one code path (dedicated == all defaults).

Phasing lets Phase 1 ship value immediately while Phase 2's contracts are designed deliberately; Phase 1's `aipm.repo.ts` is forward-compatible with being absorbed as a subset of `aipm.workspace.ts`.

## Out of scope (by decision)

- Auto-generating or syncing skills from the CLI's command surface / `--help`. Skills stay hand-authored. (Worth revisiting later as a high-value follow-up: a *drift check* that flags skills referencing commands/flags the CLI no longer has.)

## Verification (of the design — concrete checks before/while implementing)

1. **Confirm the host consumption contract** — clone a minimal repo and, with Claude Code, Cursor, **and Codex** (`codex plugin marketplace add <owner/repo>`), run the install against (a) a registry at repo root with `source` pointing into a non-`plugins/` subdir, and (b) confirm whether `source` is resolved relative to repo root vs the registry dir, and whether `..` is tolerated. Codex's docs already state repo-root-relative + no `..`; verify Claude/Cursor match. This decides the `expectedSource` base and whether the registry can ever move.
2. **Dry-run the layout against `unraid-cli`** — sketch the on-disk tree above in a scratch copy and confirm no path collides with the real repo's existing `plugins/`, `dist/`, `docs/`, `commands/`.
3. **Backward-compat oracle** — confirm that with no `aipm.repo.ts`/`aipm.workspace.ts`, `aipm build`/`validate` on the existing `template` produce byte-identical output (the `dist/**` freshness check is the oracle).
4. **Phase-1 acceptance** — in a fixture repo with a pre-existing foreign `plugins/`, set `pluginsRoot: 'agent-plugins'`, scaffold two plugins, and confirm `aipm build`/`validate` register both under `./agent-plugins/<name>` and emit Gemini/Kiro bundles under the remapped `distRoot`.
5. **Codex target acceptance** — scaffold a plugin with `codex` in its targets; confirm the toolkit emits `.codex-plugin/plugin.json`, the third `.agents/plugins/marketplace.json` registry (with `policy`/`category`), reuses `hooks/hooks.json`, and that `codex plugin marketplace add <local-path>` installs it. Add a `codex` case to the all-targets enumerations in `scaffold.test.ts` and the `test-support/` fixtures.

## Sources (Codex conventions)

- [Codex Plugins overview](https://developers.openai.com/codex/plugins) · [Build plugins](https://developers.openai.com/codex/plugins/build)
- [Skills](https://developers.openai.com/codex/skills) · [Subagents](https://developers.openai.com/codex/subagents) · [Hooks](https://developers.openai.com/codex/hooks)
- [MCP](https://developers.openai.com/codex/mcp) · [Config reference](https://developers.openai.com/codex/config-reference) · [AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
