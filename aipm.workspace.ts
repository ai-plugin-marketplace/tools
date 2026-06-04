import { defineWorkspace } from '@ai-plugin-marketplace/core';

/**
 * Marketplace metadata for this repo's embedded marketplace. Its presence opts the repo into
 * generated marketplace registries (`.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/`) and,
 * since the marketplace exposes a single plugin, the repo-root Gemini extension / Kiro power.
 */
export default defineWorkspace({
  marketplace: {
    name: 'ai-plugin-marketplace',
    owner: { name: 'mike-north' },
    description:
      'Agent plugins for authoring AI plugin marketplaces with the @ai-plugin-marketplace toolkit.',
  },
});
