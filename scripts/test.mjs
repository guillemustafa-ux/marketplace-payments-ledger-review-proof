import { runVitest } from './run-vitest.mjs';

// npm test = the specs on v2 (all green) plus the controls on v1 (green on both versions).

const v2 = runVitest({ target: 'v2' });
if (v2.failed === undefined) {
  console.error('npm test: the v2 run produced no report (infrastructure failure).');
  process.exit(1);
}
if (v2.failed.length > 0) {
  console.error(`\nnpm test FAILED: ${v2.failed.length} spec(s) failed on v2:\n${v2.failed.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

const v1 = runVitest({ target: 'v1', testNamePattern: 'CONTROL' });
if (v1.failed === undefined) {
  console.error('npm test: the v1 control run produced no report (infrastructure failure).');
  process.exit(1);
}
if (v1.failed.length > 0) {
  console.error(`\nnpm test FAILED: ${v1.failed.length} control(s) failed on v1:\n${v1.failed.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(`\nnpm test OK: ${v2.passed} specs passed on v2, ${v1.passed} controls passed on v1.`);
