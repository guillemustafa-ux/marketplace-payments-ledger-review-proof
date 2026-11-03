import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run the vitest suite once with a given TARGET and optional name filter, and return the
 * failed test names. `failed === undefined` means the runner produced no report at all.
 */
export function runVitest({ target, testNamePattern, cwd = root } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'payments-ledger-vitest-'));
  const report = join(dir, 'report.json');
  try {
    const vitestBin = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
    const args = [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile=${report}`];
    if (testNamePattern) args.push('-t', testNamePattern);
    const result = spawnSync(process.execPath, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, TARGET: target },
    });
    if (!existsSync(report)) return { failed: undefined, passed: 0, exitCode: result.status };
    const results = JSON.parse(readFileSync(report, 'utf8'));
    const failed = [];
    let passed = 0;
    for (const file of results.testResults ?? []) {
      const assertions = file.assertionResults ?? [];
      for (const t of assertions) {
        if (t.status === 'failed') failed.push(t.fullName ?? t.title);
        else if (t.status === 'passed') passed += 1;
      }
      if (file.status === 'failed' && !assertions.some((t) => t.status === 'failed')) {
        failed.push(`${file.name}: ${String(file.message ?? 'unknown').split(/\r?\n/)[0]}`);
      }
    }
    return { failed, passed, exitCode: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
