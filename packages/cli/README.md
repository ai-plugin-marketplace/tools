# @ai-plugin-marketplace/cli

The `aipm` binary — a thin CLI wrapper around
[`@ai-plugin-marketplace/core`](../core).

## Install

```sh
pnpm add -D @ai-plugin-marketplace/cli
```

## Commands

| Command                             | Description                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `aipm init [dir]`                   | Scaffold a new plugin repo (default: cwd)             |
| `aipm build [path]`                 | Build plugin artifacts (default: cwd)                 |
| `aipm validate [path]`              | Run validators without modifying the filesystem       |
| `aipm scaffold <name>`              | Create a new plugin from templates                    |
| `aipm migrate [path]`               | Apply schema migrations (no-op in this version)       |
| `aipm check-support <plugin>`       | Diagnose a plugin's target support envelope           |
| `aipm add-target <plugin> <target>` | Scaffold target-specific files for an existing plugin |
| `aipm list-targets`                 | List target IDs this toolkit version knows about      |

## Quick start

```sh
aipm init my-plugins
cd my-plugins
aipm scaffold my-plugin
```

## Upgrading

```sh
pnpm up @ai-plugin-marketplace/cli
```

For major upgrades, run `aipm migrate` after updating to apply any schema migrations.

## Links

- [Architecture spec](../../docs/specs/architecture.md) (§8.2 for CLI contract details)
- [Repository](https://github.com/ai-plugin-marketplace/tools)

## License

MIT
