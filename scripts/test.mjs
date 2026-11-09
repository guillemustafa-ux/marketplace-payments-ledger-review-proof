import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, specTitles } from './findings.mjs';
import { runVitest } from './run-vitest.mjs';

// npm test = the specs on v2 (all green) plus the controls on v1 (green on both versions).
// A run counts only if vitest exits 0 and every expected spec passed: a run where the database
// never started reports no failures, and must not read as green.

const titles = specTitles();
const controls = titles.filter((title) => title.startsWith('CONTROL '));

function requireAllPassed(run, expected, what) {
  if (run.failed === undefined) {
    console.error(`npm test: the ${what} run produced no report (infrastructure failure).`);
    process.exit(1);
  }
  if (run.failed.length > 0) {
    console.error(`\nnpm test FAILED: ${run.failed.length} failed in the ${what} run:\n${run.failed.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  if (run.exitCode !== 0 || run.passed !== expected) {
    console.error(`\nnpm test FAILED: ${run.passed} of ${expected} passed in the ${what} run (vitest exit code ${run.exitCode}); see the output above.`);
    process.exit(1);
  }
}

const v2 = runVitest({ target: 'v2' });
requireAllPassed(v2, titles.length, 'v2');

const v1 = runVitest({ target: 'v1', testNamePattern: 'CONTROL' });
requireAllPassed(v1, controls.length, 'v1 control');

console.log(`\nnpm test OK: ${v2.passed} specs passed on v2, ${v1.passed} controls passed on v1.`);

// The README's numbers and locations are generated; fail if they are stale.
const readme = spawnSync(process.execPath, [join(root, 'scripts', 'readme.mjs'), '--check'], { stdio: 'inherit' });
if (readme.status !== 0) process.exit(1);
