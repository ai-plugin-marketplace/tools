import { runBuild } from './build.js';
import { isObservedIoError, observeRepositoryIo } from './repository-fs.js';
import { runValidate } from './validate.js';
import type { BuildOptions, BuildOutcome, BuildResult } from './types.js';

function summarizeFindings(findings: BuildOutcome['validation']['findings']): string {
  return findings.map((f) => `  [${f.plugin ?? '?'}] ${f.code}: ${f.message}`).join('\n');
}

export function runBuildWithOutcome(
  targetPath: string,
  opts?: BuildOptions,
): Promise<BuildOutcome> {
  return observeRepositoryIo(targetPath, async (ioFindings) => {
    const validate = () => runValidate(targetPath, { ci: Boolean(process.env['CI']) });
    let results: BuildResult[];
    try {
      results = await runBuild(targetPath, { ...opts, failFast: false });
    } catch (cause) {
      if (ioFindings.size === 0) throw cause;
      // A failed generation has no BuildResult to return. Include findings that validation can
      // still establish and retain the generation error as the cause.
      const findings = await validate().then(
        (validation) => validation.findings,
        () => [],
      );
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${message}\n${summarizeFindings([...findings, ...ioFindings.values()])}`, {
        cause,
      });
    }

    let findings: BuildOutcome['validation']['findings'];
    try {
      ({ findings } = await validate());
    } catch (error) {
      if (!isObservedIoError(error)) throw error;
      findings = [];
    }
    findings = [...findings, ...ioFindings.values()];

    if (opts?.failFast) {
      const hard = findings.filter((f) => f.severity === 'hard' && f.code !== 'freshness');
      if (hard.length > 0) {
        const drift = findings.filter((f) => !hard.includes(f));
        throw new Error(
          `Build produced ${String(hard.length)} hard validation finding(s):\n${summarizeFindings(hard)}` +
            (drift.length === 0 ? '' : `\nOther validation findings:\n${summarizeFindings(drift)}`),
        );
      }
    }

    return {
      results,
      validation: { findings, passed: !findings.some((f) => f.severity === 'hard') },
    };
  });
}
