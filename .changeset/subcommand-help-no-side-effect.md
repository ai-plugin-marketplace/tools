---
'@ai-plugin-marketplace/cli': patch
---

Fix `-h`/`--help` on subcommands (`build`, `validate`, `lint`, `scaffold`, `init`, `migrate`, `check-support`, `add-target`, `list-targets`) executing the subcommand instead of printing usage — `aipm build --help` ran a real build, and `aipm validate --help` misparsed `--help` as the target path. `--help`/`-h` now short-circuits to usage and exits 0 before any argument parsing or side effect, for every subcommand.
