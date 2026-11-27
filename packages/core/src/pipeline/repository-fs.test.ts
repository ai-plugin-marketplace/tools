import * as fs from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

it('routes production filesystem access and config module loading through their adapters', () => {
  const src = path.resolve(import.meta.dirname, '..');
  const violations: string[] = [];
  for (const relative of fs.readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    if (
      !relative.endsWith('.ts') ||
      relative.endsWith('.test.ts') ||
      relative.split(path.sep)[0] === 'test-support' ||
      relative === path.join('pipeline', 'repository-fs.ts')
    ) {
      continue;
    }
    const file = ts.createSourceFile(
      relative,
      fs.readFileSync(path.join(src, relative), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                node.expression.getText(file) === 'require')
            ? node.arguments[0]
            : undefined;
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
        : ts.isExportDeclaration(node) && node.isTypeOnly;
      if (
        !typeOnly &&
        specifier !== undefined &&
        ts.isStringLiteral(specifier) &&
        (/^(?:node:)?fs(?:\/promises)?$/.test(specifier.text) ||
          (specifier.text === 'jiti' && relative !== path.join('pipeline', 'config-jiti.ts')))
      ) {
        violations.push(relative);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(violations).toEqual([]);
});
