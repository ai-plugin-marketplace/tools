# Design Spec: Dogfooding `tools` as a Marketplace + Native Cross-Host Install

> **Status:** design spec (no implementation). Captures the decisions made while scoping the "meta" goal: `ai-plugin-marketplace/tools` should itself be an embedded marketplace that equips a coding agent to add marketplace support to any software repo — installable through each host's **conventional native** mechanism.

## The steel thread

An OSS author turns a single repo (often a monorepo) into **both** the source of their software **and** an AI-plugin marketplace that equips coding agents to use that software effectively. The toolchain (`@ai-plugin-marketplace/*`) is the foundation for this — and should **be** an instance of it: an author runs the conventional install for their assistant against `ai-plugin-marketplace/tools` and gets a plugin that equips their agent to add marketplace support to their own repos.

## Locked decisions

1. **No universal installer of our own.** We rely on each host's conventional, native install of a git-repo. (The external `vercel-labs/plugins` CLI — `npx plugins add owner/repo` — is a convenience that already does native translation for the hosts it supports; we target it where it works but do not depend on or rebuild it.)
2. **Native, never lowest-common-denominator.** Installing into a host must yield that host's _native_ plugin (hooks/agents/commands/MCP), not a reduced skills-only artifact. This is a tested invariant.
3. **Gemini/Kiro: one declarer per host (Choice 1).** Those hosts have no multi-plugin marketplace concept — they install one extension/power per repo from the **repo root**. The precise rule is **per-host, not whole-repo**: at most one plugin may declare `gemini`, and — independently — at most one may declare `kiro`. So a two-plugin repo where plugin A declares `gemini` and plugin B declares `kiro` is allowed: it emits two _distinct_ root artifacts (`gemini-extension.json` from A, `POWER.md` from B) that don't collide. The hard validation finding fires only when **more than one plugin declares the _same_ single-artifact host** (e.g. two plugins both declaring `gemini`), since that would need two `gemini-extension.json` at the root. (Merging N→1 into a single artifact is shelved as a future `aggregate` opt-in.)
4. **Install source for Gemini/Kiro = repo root.**

## Native-install model (verified against vendor docs + the `plugins` bundle)

| Host        | Multi-plugin marketplace from a git repo? | Repo-root manifest the host reads                          | Conventional native install                        |
| ----------- | ----------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| Claude Code | ✅ `.claude-plugin/marketplace.json`      | per-plugin `.claude-plugin/plugin.json`                    | `/plugin marketplace add owner/repo`               |
| Cursor      | ✅ `.cursor-plugin/marketplace.json`      | per-plugin `.cursor-plugin/plugin.json`                    | Dashboard → Settings → Plugins → Import (repo URL) |
| Codex       | ✅ `.agents/plugins/marketplace.json`†    | per-plugin `.codex-plugin/plugin.json`                     | `codex plugin marketplace add owner/repo`          |
| Gemini      | ❌ one extension at repo root             | `gemini-extension.json` (+ `GEMINI.md`, `commands/*.toml`) | `gemini extensions install <git>`                  |
| Kiro        | ❌ one power at repo root                 | `POWER.md` (+ `mcp.json`, `steering/`)                     | "Add power from GitHub" (repo URL)                 |

† per OpenAI's published docs (what the toolchain generates); the unpublished `plugins` CLI currently looks at `.codex-plugin/marketplace.json` — see the divergence note below.

The toolchain already generates the three native marketplaces (Claude/Cursor/Codex) via the Phase A registry codegen (opt-in `aipm.workspace.ts`). The `plugins` CLI discovers from `.claude-plugin/marketplace.json` (among others) and translates to native per target — so the same generated registries serve both each host's own installer **and** `plugins`.

**Codex path divergence (watch item):** OpenAI's published docs put the Codex marketplace at `.agents/plugins/marketplace.json` (what our toolchain generates), but the unpublished `plugins` CLI looks for `.codex-plugin/marketplace.json`. Discovery still succeeds via `.claude-plugin/marketplace.json`. Track until `plugins` is published; reconcile then.

## Toolchain work required

Most of the foundation already exists (embedded marketplaces, Codex target, Phase A registry codegen). This goal adds **one** capability:

- **Gemini/Kiro repo-root native emission + N=1 gate.** Today the `gemini`/`kiro` targets emit per-plugin bundles under `dist/<target>/<plugin>/`. New: when exactly one plugin declares `gemini` (resp. `kiro`), `aipm build` also emits that plugin's `gemini-extension.json` + `GEMINI.md` + `commands/` (resp. `POWER.md` + `mcp.json` + `steering/`) at the **repo root**, committed and freshness-checked. A new hard validation finding (proposed code: `single-artifact-host`) fires when more than one plugin declares the **same** single-artifact host (e.g. two plugins both declaring `gemini`). Root emission for a host is gated on that host being declared by exactly one plugin; the two hosts are independent.

(No new installer, no new target, no cross-plugin merge.)

## Native-fidelity test strategy (decision 2)

For each host, prove the install yields a _native_ plugin, not an LCD skill:

The assertion is **host-native, not a fixed feature set**: each install must produce that host's native manifest **plus every native capability the plugin actually authored for that host** — never silently downgraded to skills-only when the plugin carries more. (It is _not_ "hooks + agents + commands always" — some targets are intentionally narrower; e.g. the `vercel` target is skills-only by design, and not every host supports every capability.)

- **Claude / Cursor / Codex (via `plugins`, pinned version):** run `plugins add <local checkout> --target <id>` into a temp scope (or `plugins discover` dry-run) and assert the translated plugin carries the native manifest and the capabilities the source plugin authored (e.g. if it has `hooks/` and `agents/`, those survive — not just `skills/`). Pin the `plugins` version (it is unpublished and changing) and treat its behavior as an external contract — a breaking change surfaces as a failing test rather than silent LCD drift.
- **Gemini / Kiro (direct, since `plugins` can't install them yet):** assert the repo-root `gemini-extension.json` / `POWER.md` is valid and installable via the host's own command (`gemini extensions link .` / Kiro "Add from GitHub"), carrying the plugin's authored commands/MCP/steering.
- The invariant the suite protects: **the repo exposes native per-host content**, so any conformant installer translates to native. (If the repo only exposed the universal `SKILL.md`, a host install would be LCD — the test fails in that case.)

CI caveat: `plugins` installs to `~/.cache` / `~/.cursor` / via the `claude` CLI, so tests use a dry-run/`--scope local` into a temp dir and inspect; verify which mode is inspectable before committing the harness.

## The dogfood: `tools` as an embedded marketplace

`ai-plugin-marketplace/tools` is a pnpm/nx monorepo (`packages/`, `docs/`, …). Make it a marketplace using its own toolchain:

- **`aipm.workspace.ts`** — marketplace metadata (`name: 'ai-plugin-marketplace'`, owner, description). Enables Phase A registry generation.
- **`aipm.repo.ts`** — `pluginsRoot: 'agent-plugins'` (sits beside `packages/`; demonstrates the embedded relocation even though `tools` has no `plugins/` collision today), `distDir: 'agent-plugins/dist'`.
- **One equipping plugin**, e.g. `marketplace-authoring`. To install natively into all **five hosts** (Claude Code, Cursor, Codex, Gemini, Kiro) it declares the five host targets `claude, codex, cursor, gemini, kiro` — plus `vercel`, the universal agentskills/open-plugin surface (a target, not a host, for the `plugins`-CLI fallback). Because it's the **only** plugin, the one-declarer-per-host rule is trivially satisfied for `gemini` and `kiro`, so the build emits root-level `gemini-extension.json` + `POWER.md` and `tools` installs natively into every host.

### The equipping plugin's content

The plugin operationalizes the existing [embedded-marketplace guide](../guides/embedded-marketplace.md) as agent-actionable capability. Start with **one skill** (YAGNI; split later):

- **Skill `add-marketplace-support`** — equips the agent to turn the current software repo into a marketplace: add the `@ai-plugin-marketplace/cli` dev dep, write `aipm.repo.ts`/`aipm.workspace.ts` collision-aware, scaffold a plugin, author skills/commands, run `aipm build`/`validate`, interpret findings, and wire CI. The guide is the single source for the skill body (don't duplicate prose — the skill references/embeds it).

This keeps the dogfood minimal and honest: `tools` ships its software _and_ a single plugin that teaches an agent to do for other repos exactly what we did to `tools`.

## Phasing

- **Phase 1 — Gemini/Kiro root emission + N=1 gate** (toolchain). The one missing capability; unblocks native install for those two hosts.
- **Phase 2 — Dogfood setup.** Add `aipm.workspace.ts`/`aipm.repo.ts` + the `marketplace-authoring` plugin to `tools`; `aipm build`/`validate` clean.
- **Phase 3 — Native-install test suite.** The per-host fidelity tests (pinned `plugins`).

Depends on already-merged work: embedded marketplaces, Codex target, Phase A registry codegen.

## Open questions

- **Repo-root intrusiveness.** `gemini-extension.json` / `POWER.md` at the root of a _software_ monorepo is a little noisy. Acceptable per decision 4, but confirm it doesn't conflict with anything the host software expects at root.
- **`plugins` is unpublished and changing.** Pin the version; the Codex marketplace-path divergence and target coverage (no Gemini yet) may shift.
- **Install-source inspection in CI.** Confirm `plugins discover` / `--scope local` yields inspectable output for the fidelity assertions.
- **Gemini/Kiro git-repo install granularity.** Confirm `gemini extensions install <git>` / Kiro "Add from GitHub" read the repo **root** (vs. accepting a subpath or release asset); the spec assumes root.

## Verification plan

1. **N=1 gate:** a repo with two plugins both declaring `gemini` → `aipm validate` emits the new hard finding; reducing to one clears it and `aipm build` writes root `gemini-extension.json`.
2. **Dogfood build:** `aipm build` + `aipm validate` run clean inside `tools`; the three native marketplaces + the root Gemini/Kiro artifacts + the universal `SKILL.md` all generate.
3. **Native-fidelity (per host):** the test suite above passes — each host install carries native hooks/agents/commands, not LCD skills.
4. **End-to-end smoke:** `npx plugins add <local tools checkout>` (Claude/Cursor) and `gemini extensions link .` install the equipping plugin natively.
