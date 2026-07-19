# @ai-plugin-marketplace/cli

The `aipm` binary — a thin CLI wrapper around
[`@ai-plugin-marketplace/core`](../core).

## Install

First, establish a local `package.json` so the install below cannot land in the wrong place:

```sh
mkdir my-plugins && cd my-plugins
npm init -y
pnpm add -D @ai-plugin-marketplace/cli
```

> **Workspace hazard.** If you skip `npm init -y` (or otherwise create a local `package.json`
> first) and run `pnpm add` from a directory that has no `package.json` of its own but sits
> under an existing pnpm workspace (an ancestor directory has a `pnpm-workspace.yaml`), pnpm
> will silently walk up and modify the ANCESTOR's `package.json` and lockfile instead — polluting
> an unrelated project with no warning. Always create a package boundary (`npm init -y`, or
> `aipm init`, which does this for you) before installing.

## Commands

| Command                             | Description                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aipm init [dir]`                   | Scaffold a new plugin repo (default: cwd)                                                                                                           |
| `aipm init --name <name> [dir]`     | Scaffold a new plugin repo with an explicit marketplace/package name                                                                                |
| `aipm init --refresh [dir]`         | Update toolkit-owned scaffold files in an existing repo                                                                                             |
| `aipm build [path]`                 | Build plugin artifacts (default: cwd); refuses to run with a toolkit older than the one that generated existing artifacts (see `--force-downgrade`) |
| `aipm validate [path]`              | Run validators on plugins (default: cwd)                                                                                                            |
| `aipm lint [path]`                  | Run the lint engine on plugins (default: cwd)                                                                                                       |
| `aipm scaffold <name>`              | Create a new plugin from templates                                                                                                                  |
| `aipm migrate [path]`               | Apply schema migrations (no-op in this version)                                                                                                     |
| `aipm check-support <plugin>`       | Diagnose a plugin's target support envelope                                                                                                         |
| `aipm add-target <plugin> <target>` | Scaffold target-specific files for an existing plugin                                                                                               |
| `aipm list-targets`                 | List target IDs this toolkit version knows about                                                                                                    |

### Flags

| Flag                           | Applies to           | Description                                                                                                             |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                | `init`               | Sets the new repo's marketplace name AND package name (default: `$USER-ai-plugins`); must be unique across marketplaces |
| `--refresh`                    | `init`               | Refresh an existing repo instead of creating one                                                                        |
| `--force`                      | `init --refresh`     | Overwrite locally-modified scaffold files                                                                               |
| `--force-downgrade`            | `build`              | Proceed even when the installed toolkit is older than the version that generated existing artifacts (restamps with it)  |
| `--as <mode>`                  | `lint`               | Discovery mode (only `aipm-repo` is supported today)                                                                    |
| `--format <text\|json\|sarif>` | `lint`               | Output format (default: `text`)                                                                                         |
| `--rule <id>=<severity>`       | `lint`               | Override a rule's severity (`error`\|`warn`\|`info`\|`off`); repeatable                                                 |
| `--verbose`                    | `lint --format text` | Append each diagnostic's docs URL                                                                                       |
| `--help`, `-h`                 | any                  | Show the help message                                                                                                   |
| `--version`, `-V`              | any                  | Print the toolkit version                                                                                               |

## Quick start

Starting from a directory with its own `package.json` (see Install, above — `aipm init`'s
target directory must not already exist or must be empty, so it scaffolds a fresh subdirectory
rather than the one you just `npm init`'d):

```sh
pnpm exec aipm init my-plugins
cd my-plugins
pnpm install
aipm scaffold my-plugin
```

`aipm init` also warns (to stderr) if it detects an ancestor `pnpm-workspace.yaml` above the
target directory, since a later `pnpm install` there could still be swept into that workspace.

## Upgrading

```sh
pnpm up @ai-plugin-marketplace/cli
```

For major upgrades, run `aipm migrate` after updating to apply any schema migrations.

## Links

- [Architecture spec](https://github.com/ai-plugin-marketplace/tools/blob/main/docs/specs/architecture.md) (§8.2 for CLI contract details)
- [Repository](https://github.com/ai-plugin-marketplace/tools)

## License

MIT
