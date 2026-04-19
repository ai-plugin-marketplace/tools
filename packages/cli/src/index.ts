/**
 * @ai-plugin-marketplace/cli — programmatic entry.
 *
 * The `aipm` binary lives in `bin.ts`. This module exports `run()` so host processes can
 * invoke the CLI dispatcher with an argv array of their choosing (useful for tests).
 */

export { run } from './run.js';
