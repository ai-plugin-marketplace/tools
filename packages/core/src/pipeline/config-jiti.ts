import * as nodeModule from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';

import { createJiti } from 'jiti';
import type { Jiti, JitiOptions, TransformOptions, TransformResult } from 'jiti';

import {
  configModuleFs,
  observesRepositoryIo,
  observesNativeModuleGraph,
  repositoryFs as fs,
  withConfigModuleReads,
} from './repository-fs.js';

type JitiFactory = (
  parent: string,
  options: JitiOptions,
  runtime: {
    createRequire: typeof nodeModule.createRequire;
    nativeImport: (id: string) => Promise<unknown>;
    onError: (error: unknown) => never;
  },
) => Jiti;

let guardedFactory: JitiFactory | undefined;
type Transform = (options: TransformOptions) => TransformResult;
let transform: Transform | undefined;
const requireJiti = nodeModule.createRequire(
  nodeModule.createRequire(import.meta.url).resolve('jiti'),
);

function createGuardedFactory(): JitiFactory {
  // Jiti 2.x bundles its resolver and evaluator together and has no filesystem option.
  // Give that bundle its own fs binding so overlapping builds and other Jiti consumers
  // keep their own loader behavior. Use the same bundle and lazy Babel transform as Jiti.
  const filename = requireJiti.resolve('../dist/jiti.cjs');
  const module = { exports: undefined as unknown };
  const load = compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module'], {
    filename,
  }) as (require: (id: string) => unknown, module: { exports: unknown }) => void;
  load((id) => (id === 'node:fs' ? configModuleFs : (requireJiti(id) as unknown)), module);
  return module.exports as JitiFactory;
}

function guardedRequire(parent: string | URL): NodeJS.Require {
  const require = nodeModule.createRequire(parent);
  return new Proxy(require, {
    apply(_target, _this, [id]: [string]): unknown {
      const resolved = require.resolve(id);
      if (path.isAbsolute(resolved) && !require.cache[resolved]) fs.readFileSync(resolved);
      return require(id);
    },
  });
}

function createGuardedJiti(parent: string, options: JitiOptions): Jiti {
  guardedFactory ??= createGuardedFactory();
  return guardedFactory(
    parent,
    {
      ...options,
      transform: (input) => {
        transform ??= requireJiti('../dist/babel.cjs') as Transform;
        return transform(input);
      },
    },
    {
      createRequire: observesNativeModuleGraph ? nodeModule.createRequire : guardedRequire,
      nativeImport: (id) => {
        if (!observesNativeModuleGraph) {
          if (id.startsWith('file:')) fs.readFileSync(fileURLToPath(id));
          else if (path.isAbsolute(id)) fs.readFileSync(id);
        }
        return import(id);
      },
      onError(error) {
        throw error;
      },
    },
  );
}

export function importConfigModule(
  parent: string,
  filename: string,
  options: JitiOptions,
): Promise<Record<string, unknown>> {
  if (!observesRepositoryIo()) {
    return createJiti(parent, options).import<Record<string, unknown>>(filename);
  }
  const jiti = createGuardedJiti(parent, options);
  return withConfigModuleReads(() => jiti.import<Record<string, unknown>>(filename));
}
