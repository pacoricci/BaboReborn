import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { suite, validateSuite, compareCase } from '../../frontend/tests/support/conformance';

validateSuite();
const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const results = suite.cases.map(compareCase);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  implementation: {
    language: 'TypeScript',
    revision: git('rev-parse', 'HEAD'),
    workingTreeStatus: git('status', '--short'),
    node: process.version,
  },
  reference: suite.reference,
  tolerances: suite.tolerances,
  fixture: {
    path: 'frontend/tests/fixtures/movement-reference.json',
    sha256: createHash('sha256')
      .update(
        readFileSync(
          new URL('../../frontend/tests/fixtures/movement-reference.json', import.meta.url),
        ),
      )
      .digest('hex'),
  },
  summary: {
    cases: results.length,
    conformant: results.filter((result) => result.status === 'conformant').length,
    different: results.filter((result) => result.status === 'different').length,
    differences: results.flatMap((result) => result.differences).length,
  },
  results,
};
mkdirSync(new URL('../../output/conformance/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../../output/conformance/latest.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${result.id}`);
  for (const diff of result.differences) {
    console.log(
      `  tick ${diff.tick} ${diff.field}: expected ${diff.expected}, actual ${diff.actual}, tolerance ${diff.tolerance}`,
    );
  }
}
console.log(
  `${report.summary.conformant}/${report.summary.cases} conformant; ${report.summary.different} different. Report: output/conformance/latest.json`,
);
// Every difference fails both this report command and the normal test suite.
process.exitCode = report.summary.different ? 1 : 0;
