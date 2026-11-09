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

// 2. One footgun per fix. Footgun f<n> must name the F<n> spec; it may also name other finding
// specs its edit breaks (f4 also breaks F5, whose full-refund-in-parts check needs every partial).
const manifest = JSON.parse(readFileSync(join(root, 'footguns', 'manifest.json'), 'utf8'));
const footgunFor = {};
for (const [name, entry] of Object.entries(manifest)) {
  const own = /^f([1-9])$/.exec(name);
  if (!own) {
    problems.push(`footgun ${name} must be named f<n>`);
    continue;
  }
  const f = `F${own[1]}`;
  const expected = entry.expectedFailures ?? [];
  if (!expected.some((title) => findingId(title) === f)) problems.push(`footgun ${name} must name the ${f} spec`);
  for (const title of expected) {
    if (!titles.includes(title)) problems.push(`footgun ${name} names a spec that does not exist: ${title}`);
    else if (!findingId(title)) problems.push(`footgun ${name} may name only finding specs, not: ${title}`);
  }
  footgunFor[f] = name;
}
for (const f of F_NAMES) if (!footgunFor[f]) problems.push(`no footgun for ${f}`);

// 3. The sample report written by `npm run review`: its stats and, for every finding, the
// current title, severity, v1 location and spec, so a stale report fails the check.
const severityCounts = { Critical: 0, High: 0, Medium: 0 };
for (const f of F_NAMES) severityCounts[SEVERITY[f]] += 1;

const reportPath = join(root, 'SAMPLE_REPORT.md');
const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
let stats = null;
const statsMatch = /<!-- review-stats ([^>]+) -->/.exec(report);
if (statsMatch) stats = Object.fromEntries(statsMatch[1].trim().split(/\s+/).map((pair) => pair.split('=')));
if (!stats) problems.push('SAMPLE_REPORT.md has no review-stats line (run npm run review)');
else {
  const expectedStats = {
    findingsOpen: F_NAMES.length,
    retestsClosed: F_NAMES.length,
    critical: severityCounts.Critical,
    high: severityCounts.High,
    medium: severityCounts.Medium,
  };
  for (const [key, value] of Object.entries(expectedStats)) {
    if (Number(stats[key]) !== value) problems.push(`SAMPLE_REPORT.md ${key} is ${stats[key]}, expected ${value} (run npm run review)`);
  }
}
const verdict = `**Verdict (v1): ${F_NAMES.length} findings open (${severityCounts.Critical} Critical, ${severityCounts.High} High, ${severityCounts.Medium} Medium).** Retest against v2: ${F_NAMES.length} of ${F_NAMES.length} closed.`;
if (!report.includes(verdict)) problems.push('SAMPLE_REPORT.md verdict line does not match the findings (run npm run review)');
const reportRows = report.split(/\r?\n/);
F_NAMES.forEach((f, i) => {
  const row = reportRows.find((line) => line.startsWith(`| ${i + 1} | `));
  const head = `| ${i + 1} | ${FINDINGS[f].title} | ${SEVERITY[f]} | \`${defects.locations[f]}\` | \``;
  const spec = `${findingSpecs[f]?.[0]}\` | `;
  const tail = `| ${FINDINGS[f].fix} | Closed |`;
  if (!row || !row.startsWith(head) || !row.includes(spec) || !row.endsWith(tail)) {
    problems.push(`SAMPLE_REPORT.md row ${i + 1} does not match the current title, severity, location, spec and fix of ${f} (run npm run review)`);
  }
});

// 4. Render.

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
    '| Footgun | What it reintroduces | Specs that must fail |',
    '| --- | --- | --- |',
    ...Object.entries(manifest).map(
      ([name, entry]) => `| \`${name}\` | ${entry.description} | ${entry.expectedFailures.map((title) => `\`${title}\``).join(', ')} |`,
    ),
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
