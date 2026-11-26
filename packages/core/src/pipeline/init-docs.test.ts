import { readFileSync } from 'node:fs';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const workspace = new URL('../../../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, workspace), 'utf8');
}

function initOptionDeclarations(markdown: string): string[] {
  const options = /export interface InitOptions \{([^}]+)\}/.exec(markdown)?.[1] ?? '';
  return options
    .split(/\r?\n/)
    .map((line) => line.split('//')[0]?.trim() ?? '')
    .filter(Boolean)
    .sort();
}

describe('init and upgrade documentation', () => {
  it('documents the public init option declarations', () => {
    const spec = read('docs/specs/architecture.md');
    const report = read('packages/core/api-report/core.api.md');
    const options = initOptionDeclarations(report);
    expect(options.length).toBeGreaterThan(0);
    expect(initOptionDeclarations(spec)).toEqual(options);
    expect(spec).toContain('function init(dir: string, opts?: InitOptions)');
  });

  it.each(['docs/specs/architecture.md', 'RELEASING.md'])(
    '%s shows how to select both versions when core crosses a caret boundary',
    (file) => {
      const doc = read(file);
      const inRange = 'pnpm up @ai-plugin-marketplace/cli @ai-plugin-marketplace/core';
      const explicitUpgrade =
        /pnpm add -D @ai-plugin-marketplace\/cli@(\S+) @ai-plugin-marketplace\/core@(\S+)/.exec(
          doc,
        );
      expect(doc).toContain(inRange);
      const [, cliVersion = '', coreVersion = ''] = explicitUpgrade ?? [];
      expect(semver.satisfies(cliVersion, '^0.8.0')).toBe(true);
      expect(semver.satisfies(coreVersion, '^0.11.0')).toBe(false);
      expect(semver.satisfies(coreVersion, '^0.12.0')).toBe(true);
    },
  );
});
