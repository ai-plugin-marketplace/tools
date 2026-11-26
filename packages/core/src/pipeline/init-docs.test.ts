import { readFileSync } from 'node:fs';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const workspace = new URL('../../../../', import.meta.url);

function normalizeLineEndings(markdown: string): string {
  return markdown.replaceAll('\r\n', '\n');
}

function read(relativePath: string): string {
  return normalizeLineEndings(readFileSync(new URL(relativePath, workspace), 'utf8'));
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

  it.each([
    { file: 'docs/specs/architecture.md', lineEndings: 'LF' },
    { file: 'docs/specs/architecture.md', lineEndings: 'CRLF' },
    { file: 'RELEASING.md', lineEndings: 'LF' },
    { file: 'RELEASING.md', lineEndings: 'CRLF' },
  ])(
    '$file shows how to upgrade a compatible pair across a core caret boundary ($lineEndings)',
    ({ file, lineEndings }) => {
      const markdown = read(file).replaceAll('\n', lineEndings === 'CRLF' ? '\r\n' : '\n');
      const doc = normalizeLineEndings(markdown);
      const inRange = 'pnpm up @ai-plugin-marketplace/cli @ai-plugin-marketplace/core';
      const compatibility =
        "the selected core version satisfies the selected CLI release's core dependency range";
      expect(doc).toContain(`${inRange}\npnpm exec aipm build\n`);
      expect(doc).toMatch(/`pnpm exec aipm migrate` before `pnpm exec aipm build`/);
      expect(doc).not.toMatch(/^aipm (build|migrate)\b/m);
      expect(doc.replace(/\s+/g, ' ').split(inRange)[0]).toContain(compatibility);

      const explicitUpgrade =
        /pnpm add -D @ai-plugin-marketplace\/cli@(\S+) @ai-plugin-marketplace\/core@(\S+)/.exec(
          doc,
        );
      expect(explicitUpgrade).not.toBeNull();
      expect(doc).toContain(`${explicitUpgrade?.[0] ?? ''}\npnpm exec aipm build\n`);
      const [, cliVersion = '', coreVersion = ''] = explicitUpgrade ?? [];
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
      expect(doc.replace(/\s+/g, ' ')).toContain(
        `CLI \`${cliVersion}\` depends on core \`${cliCoreRange ?? ''}\``,
      );
      const previousCoreRange = /existing core range `(\^[^`]+)`/.exec(doc)?.[1] ?? '';
      expect(semver.validRange(previousCoreRange)).not.toBeNull();
      expect(semver.satisfies(coreVersion, previousCoreRange)).toBe(false);
    },
  );

  it('documents the bundled release guarantee and the CLI version source in the refresh spec', () => {
    const spec = read('docs/specs/scaffold-refresh-and-upgrade.md');
    const pinning = spec.split('## Prerequisite fix')[1]?.split('\n## ')[0] ?? '';
    const regression = spec.split('**Version-skew regression:**')[1]?.split('**UAT')[0] ?? '';
    expect(pinning).toContain('defaults to the CLI release bundled with core');
    expect(pinning).toContain('must write a range that includes that release');
    expect(pinning).toMatch(/uses the CLI\s+release from its installed `package.json`/);
    expect(pinning).not.toContain('`InitOptions.cliVersion`');
    expect(regression).toMatch(
      /bundled CLI release\s+and rejects ranges that exclude it before writing/,
    );
    expect(regression).toMatch(/`aipm init` uses its installed CLI\s+version/);
  });

  it('preserves the Open Plugins changeset requirement for both independently versioned packages', () => {
    const spec = read('docs/specs/open-plugins-target.md');
    const requirement = spec.split('**OP-D11 (normative).**')[1]?.split('### 9.2')[0] ?? '';
    expect(requirement).not.toMatch(/lockstep/);
    expect(requirement).toMatch(
      /A changeset for\s*>?\s*both packages accompanies the implementation/,
    );
  });
});
