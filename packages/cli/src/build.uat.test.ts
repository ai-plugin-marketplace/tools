import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';

const cliDir = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(cliDir, 'dist', 'bin.js');

beforeAll(() => {
  execFileSync('pnpm', ['exec', 'tsc', '--build'], { cwd: cliDir, stdio: 'inherit' });
}, 120_000);

it.each([
  {
    name: 'valid on every evaluation',
    invalidOnThird: false,
    status: 0,
    report: 'Built 1 plugin(s), 0 artifact(s).\nOK — no findings.\n',
  },
  {
    name: 'invalid on the third evaluation',
    invalidOnThird: true,
    status: 1,
    report:
      '[test] envelope-invalid (hard): Invalid aipm.config.ts: ' +
      JSON.stringify(
        [
          {
            origin: 'array',
            code: 'too_small',
            minimum: 1,
            inclusive: true,
            path: ['targets'],
            message: 'targets must contain at least one target',
          },
        ],
        null,
        2,
      ) +
      '\n',
  },
])('matches origin/main CLI reporting for a config $name', ({ invalidOnThird, status, report }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-cli-build-'));
  const plugin = path.join(repo, 'plugins', 'test');
  try {
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"test"}');
    fs.writeFileSync(
      path.join(plugin, 'aipm.config.ts'),
      `const run = (globalThis.aipmConfigRuns = (globalThis.aipmConfigRuns ?? 0) + 1);
console.log('config stdout');
console.error('config stderr');
export default { version: '0.1.0', targets: ${String(invalidOnThird)} && run === 3 ? [] : ['claude'] };
`,
    );

    const result = spawnSync(process.execPath, [bin, 'build', '.'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status,
      stdout: 'config stdout\n'.repeat(3) + report,
      stderr: 'config stderr\n'.repeat(3),
    });
  } finally {
    fs.rmSync(repo, { recursive: true });
  }
});
