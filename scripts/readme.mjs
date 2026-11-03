// Renders the generated regions of README.md (every number and every file:line in it comes
// from here) and, with --check, fails when the README is out of date or the repository
// breaks one of the structural promises the README makes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { F_NAMES, FINDINGS, SEVERITY, findingId, locateMarkers, root, specTitles } from './findings.mjs';

const readmePath = join(root, 'README.md');
const check = process.argv.includes('--check');
const problems = [];

// 1. Structural promises: one marker per finding in each version, one spec per finding.
const defects = locateMarkers('v1', 'DEFECT');
const fixes = locateMarkers('v2', 'FIX');
for (const f of F_NAMES) {
  if (defects.counts[f] !== 1) problems.push(`expected exactly one "// DEFECT ${f}" in src/v1, found ${defects.counts[f] ?? 0}`);
  if (fixes.counts[f] !== 1) problems.push(`expected exactly one "// FIX ${f}" in src/v2, found ${fixes.counts[f] ?? 0}`);
}
const titles = specTitles();
const findingSpecs = {};
for (const title of titles) {
  const id = findingId(title);
  if (id) (findingSpecs[id] ??= []).push(title);
}
const controls = titles.filter((t) => t.startsWith('CONTROL '));
for (const f of F_NAMES) {
  if ((findingSpecs[f] ?? []).length !== 1) problems.push(`expected exactly one spec for ${f}, found ${(findingSpecs[f] ?? []).length}`);
}
if (titles.length !== controls.length + Object.values(findingSpecs).flat().length) {
  problems.push('every spec must be named "F<n> ..." or "CONTROL ..."');
}

// 2. One footgun per fix, each naming exactly its own spec.
const manifest = JSON.parse(readFileSync(join(root, 'footguns', 'manifest.json'), 'utf8'));
const footgunFor = {};
for (const [name, entry] of Object.entries(manifest)) {
  const expected = entry.expectedFailures;
  const ids = expected.map(findingId);
  if (expected.length !== 1 || !ids[0]) {
    problems.push(`footgun ${name} must name exactly one F spec`);
    continue;
  }
  footgunFor[ids[0]] = name;
  if (!titles.includes(expected[0])) problems.push(`footgun ${name} names a spec that does not exist: ${expected[0]}`);
}
for (const f of F_NAMES) if (!footgunFor[f]) problems.push(`no footgun for ${f}`);

// 3. The review stats written by `npm run review`.
const reportPath = join(root, 'SAMPLE_REPORT.md');
let stats = null;
if (existsSync(reportPath)) {
  const match = /<!-- review-stats ([^>]+) -->/.exec(readFileSync(reportPath, 'utf8'));
  if (match) stats = Object.fromEntries(match[1].trim().split(/\s+/).map((pair) => pair.split('=')));
}
if (!stats) problems.push('SAMPLE_REPORT.md has no review-stats line (run npm run review)');
else if (Number(stats.findingsOpen) !== F_NAMES.length) problems.push('SAMPLE_REPORT.md findingsOpen does not match the findings');

// 4. Render.
const severityCounts = { Critical: 0, High: 0, Medium: 0 };
for (const f of F_NAMES) severityCounts[SEVERITY[f]] += 1;

const regions = {
  stats: [
    `- Specs: ${titles.length} (${F_NAMES.length} finding specs and ${controls.length} controls).`,
    `- Findings planted in v1: ${Object.keys(defects.locations).length} (${severityCounts.Critical} Critical, ${severityCounts.High} High, ${severityCounts.Medium} Medium), each with one \`// DEFECT F<n>\` marker; v2 has ${Object.keys(fixes.locations).length} \`// FIX F<n>\` markers.`,
    `- Footguns: ${Object.keys(manifest).length}, one per fix.`,
    stats ? `- Last \`npm run review\`: ${stats.findingsOpen} findings open on v1, ${stats.retestsClosed} closed on v2.` : '- Last `npm run review`: not run yet.',
  ].join('\n'),
  findings: [
    '| # | Finding | Severity | Defect (v1) | Fix (v2) | Spec | Footgun |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...F_NAMES.map(
      (f, i) =>
        `| ${i + 1} | ${FINDINGS[f].title} | ${SEVERITY[f]} | \`${defects.locations[f]}\` | \`${fixes.locations[f]}\` | \`${findingSpecs[f]?.[0] ?? '?'}\` | \`${footgunFor[f] ?? '?'}\` |`,
    ),
  ].join('\n'),
  footguns: [
    '| Footgun | What it reintroduces | Spec that must fail |',
    '| --- | --- | --- |',
    ...Object.entries(manifest).map(([name, entry]) => `| \`${name}\` | ${entry.description} | \`${entry.expectedFailures[0]}\` |`),
  ].join('\n'),
};

let readme = readFileSync(readmePath, 'utf8');
for (const [name, body] of Object.entries(regions)) {
  const pattern = new RegExp(`(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`);
  if (!pattern.test(readme)) {
    problems.push(`README.md has no generated:${name} region`);
    continue;
  }
  readme = readme.replace(pattern, (_all, open, close) => `${open}\n${body}\n${close}`);
}

if (check) {
  const onDisk = readFileSync(readmePath, 'utf8');
  if (onDisk !== readme) problems.push('README.md is out of date: run npm run readme');
  if (problems.length > 0) {
    console.error('readme check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('readme check OK: generated regions are current and the structural promises hold.');
} else {
  if (problems.length > 0) {
    console.error('readme: problems found:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  writeFileSync(readmePath, readme, 'utf8');
  console.log('README.md regenerated.');
}
