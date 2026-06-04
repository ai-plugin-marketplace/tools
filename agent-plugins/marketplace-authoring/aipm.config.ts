import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '0.1.0',
  targets: ['claude', 'codex', 'cursor', 'gemini', 'kiro', 'vercel'],
  description:
    'Turn a software repo into an AI plugin marketplace with the aipm toolkit: add embedded-marketplace support, scaffold and author plugins, and build/validate across Claude Code, Cursor, Codex, Gemini, and Kiro.',
  keywords: [
    'ai-plugin-marketplace',
    'aipm',
    'marketplace',
    'plugin',
    'agent-skills',
    'claude-code',
    'cursor',
    'codex',
    'gemini',
    'kiro',
  ],
});
