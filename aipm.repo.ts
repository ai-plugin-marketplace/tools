import { defineRepoConfig } from '@ai-plugin-marketplace/core';

/**
 * This monorepo is both the source of the `@ai-plugin-marketplace/*` toolchain AND a marketplace
 * for the agent plugin that teaches a coding agent to use it. The toolchain's own packages live
 * under `packages/`, so the marketplace's plugins are relocated to `agent-plugins/` (and its
 * generated bundles to `agent-plugins/dist/`) to keep the two concerns from colliding.
 */
export default defineRepoConfig({
  pluginsRoot: 'agent-plugins',
  distDir: 'agent-plugins/dist',
});
