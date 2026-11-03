import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITS } from '../footguns/edits.mjs';
import { runVitest } from './run-vitest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'footguns', 'manifest.json'), 'utf8'));

const requested = process.argv[2];
const names = requested === '--all' ? Object.keys(manifest) : requested ? [requested] : null;
if (!names) {
  console.error('Usage: npm run footgun -- <name>\n         npm run footgun -- --all\n\nAvailable footguns:');
  for (const [key, value] of Object.entries(manifest)) console.error(`  ${key}  ${value.description}`);
  process.exit(1);
}
for (const name of names) {
  if (!manifest[name]) {
    console.error(`unknown footgun: ${name}`);
    process.exit(1);
  }
}

let allPassed = true;
for (const name of names) {
  if (!runFootgun(name)) allPassed = false;
}
if (!allPassed) {
  console.error('\nfootgun run FAILED (one or more footguns did not match expectations).');
  process.exit(1);
}
console.log(`\nfootgun run OK: ${names.length} footgun(s) each failed exactly the documented specs.`);

/**
 * Copy the source to a throwaway directory, junction the real node_modules, apply one
 * footgun's edits there, run the suite, and compare failures to the manifest. The working
 * tree is never touched.
 */
function runFootgun(name) {
  const entry = manifest[name];
  const edits = EDITS[name];
  const temp = mkdtempSync(join(tmpdir(), 'payments-ledger-footgun-'));
  try {
    cpSync(join(root, 'src'), join(temp, 'src'), { recursive: true });
    cpSync(join(root, 'test'), join(temp, 'test'), { recursive: true });
    for (const file of ['vitest.config.ts', 'package.json', 'tsconfig.json']) {
      copyFileSync(join(root, file), join(temp, file));
    }
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    for (const edit of edits) {
      const path = join(temp, edit.file);
      const content = readFileSync(path, 'utf8');
      const count = content.split(edit.find).length - 1;
      if (count === 0) {
        console.error(`FAIL: ${name}: edit for ${edit.file} did not match (find text not found).`);
        return false;
      }
      if (count > 1) {
        console.error(`FAIL: ${name}: edit for ${edit.file} matched ${count} times (expected once).`);
        return false;
      }
      writeFileSync(path, content.replace(edit.find, edit.replace), 'utf8');
    }

    console.log(`\n--- footgun applied: ${name} -- ${entry.description}`);
    console.log('--- running the suite; the documented specs must fail now ---');
    const result = runVitest({ target: 'v2', cwd: temp });
    if (result.failed === undefined) {
      console.error(`FAIL: ${name}: vitest produced no report (infrastructure failure).`);
      return false;
    }
    const matches = (test, expected) => test.includes(expected);
    const missing = entry.expectedFailures.filter((expected) => !result.failed.some((f) => matches(f, expected)));
    const unexpected = result.failed.filter((f) => !entry.expectedFailures.some((expected) => matches(f, expected)));
    if (missing.length > 0) {
      console.error(`FAIL: ${name}: documented specs stayed green:`);
      for (const m of missing) console.error(`  - ${m}`);
    }
    if (unexpected.length > 0) {
      console.error(`FAIL: ${name}: undocumented specs failed:`);
      for (const u of unexpected) console.error(`  - ${u}`);
    }
    if (missing.length || unexpected.length) {
      console.error(`FAIL: ${name} -- expected exactly: ${entry.expectedFailures.join(', ')}`);
      return false;
    }
    console.log(`PASS: ${name} -- exactly the documented specs failed: ${entry.expectedFailures.join(', ')}`);
    return true;
  } finally {
    // Remove the junction first (never the real node_modules), then the temp tree.
    const nodeModules = join(temp, 'node_modules');
    try {
      rmSync(nodeModules, { recursive: false, force: true });
    } catch {
      // already removed or not a directory
    }
    rmSync(temp, { recursive: true, force: true });
  }
}
