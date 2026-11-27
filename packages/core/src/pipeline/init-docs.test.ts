import { readFileSync } from 'node:fs';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const workspace = new URL('../../../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, workspace), 'utf8').replaceAll('\r\n', '\n');
}

function shellBlocks(markdown: string) {
  return Array.from(
    markdown.matchAll(/^```(?:sh|bash)\s*\n([\s\S]*?)^```$/gm),
    ({ 1: body = '', index }) => ({
      index,
      commands: body
        .split('\n')
        .map((line) =>
          line
            .replace(/(^|\s)#.*$/, '')
            .trim()
            .replace(/\s+/g, ' '),
        )
        .filter(Boolean),
    }),
  );
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
    expect(options).toEqual([
      'cliVersion?: string;',
      'marketplaceName?: string;',
      'name?: string;',
    ]);
    expect(initOptionDeclarations(spec)).toEqual(options);
    expect(report).not.toContain('initFromCli');
    expect(spec).toContain('function init(dir: string, opts?: InitOptions)');
  });

  it.each(['docs/specs/architecture.md', 'RELEASING.md'])(
    '%s gives runnable commands for upgrading a compatible CLI and core pair',
    (file) => {
      const doc = read(file);
      const blocks = shellBlocks(doc);
      const build = 'pnpm exec aipm build';
      const update = 'pnpm up @ai-plugin-marketplace/cli @ai-plugin-marketplace/core';
      const inRange = blocks.find(({ commands }) => commands.includes(update));
      expect(inRange?.commands).toEqual([update, build]);
      expect(doc).toContain('`pnpm exec aipm migrate`');

      const addPair =
        /^pnpm add -D @ai-plugin-marketplace\/cli@(\S+) @ai-plugin-marketplace\/core@(\S+)$/;
      const explicit = blocks.find(({ commands }) => addPair.test(commands[0] ?? ''));
      const [, cliVersion = '', coreVersion = ''] = addPair.exec(explicit?.commands[0] ?? '') ?? [];
      expect(explicit?.commands[1]).toBe(build);
      // dependencies['@ai-plugin-marketplace/core'] from the published CLI tarball manifests.
      const publishedCoreRanges: Readonly<Record<string, string>> = {
        '0.7.0': '^0.10.0',
        '0.8.0': '^0.11.0',
      };
      const cliCoreRange = publishedCoreRanges[cliVersion];
      expect(cliCoreRange, `published core dependency for CLI ${cliVersion}`).toBeDefined();
      expect(
        semver.satisfies(coreVersion, cliCoreRange ?? ''),
        `core ${coreVersion} vs CLI ${cliVersion}`,
      ).toBe(true);
      const example =
        doc
          .slice(0, explicit?.index)
          .trimEnd()
          .split(/\n\s*\n/)
          .at(-1) ?? '';
      const caretRanges = Array.from(example.matchAll(/`(\^[^`]+)`/g), ([, range]) => range);
      expect(caretRanges).toContain(cliCoreRange);
      expect(
        caretRanges.some(
          (range) => range && semver.validRange(range) && !semver.satisfies(coreVersion, range),
        ),
      ).toBe(true);
    },
  );

  it.each(['CONTRIBUTING.md', 'RELEASING.md'])(
    '%s builds and packs the two publishable workspace packages',
    (file) => {
      expect(shellBlocks(read(file)).map(({ commands }) => commands)).toContainEqual([
        'pnpm build',
        'pnpm --filter @ai-plugin-marketplace/core pack',
        'pnpm --filter @ai-plugin-marketplace/cli pack',
      ]);
    },
  );
});
