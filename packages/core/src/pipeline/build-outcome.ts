import { runBuild } from './build.js';
import { isObservedIoError, observeRepositoryIo } from './repository-fs.js';
import { runValidate } from './validate.js';
import type { BuildOptions, BuildOutcome } from './types.js';

function summarizeFindings(findings: BuildOutcome['validation']['findings']): string {
  return findings.map((f) => `  [${f.plugin ?? '?'}] ${f.code}: ${f.message}`).join('\n');
}

export function runBuildWithOutcome(
  targetPath: string,
  opts?: BuildOptions,
): Promise<BuildOutcome> {
  return observeRepositoryIo(targetPath, async (ioFindings) => {
    const validate = () => runValidate(targetPath, { ci: Boolean(process.env['CI']) });
    const results = await runBuild(targetPath, opts, async (cause) => {
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
    });

    let findings: BuildOutcome['validation']['findings'];
    try {
      ({ findings } = await validate());
    } catch (error) {
      if (!isObservedIoError(error)) throw error;
      findings = [];
    }
    findings = [...findings, ...ioFindings.values()];

    return {
      results,
      validation: { findings, passed: !findings.some((f) => f.severity === 'hard') },
    };
  });
}
