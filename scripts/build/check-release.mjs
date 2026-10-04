import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const files = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
  }
}

visit(root);

const productEntries = [
  'credits.html',
  'editor.html',
  'manage.html',
  'match.html',
  'play.html',
  'privacy.html',
  'terms.html',
];
const problems = [];
for (const required of productEntries) {
  if (!files.includes(required)) problems.push(`missing product entry: ${required}`);
}
const htmlEntries = files.filter((file) => extname(file) === '.html').sort();
if (htmlEntries.join('\n') !== productEntries.join('\n')) {
  problems.push(`unclassified HTML entries: ${htmlEntries.join(', ') || '(none)'}`);
}

for (const file of files) {
  if (file.split('/').includes('.DS_Store')) {
    problems.push(`macOS metadata included: ${file}`);
  }
  if (
    ['devtools/', 'scripts/', 'tests/', 'benchmarks/'].some((directory) =>
      file.startsWith(directory),
    ) ||
    /(^|\/)practice(?:[./-]|$)/.test(file) ||
    file.includes('development-tools')
  ) {
    problems.push(`development artifact included: ${file}`);
  }

  if (!['.css', '.html', '.js', '.json', '.svg'].includes(extname(file))) continue;
  const contents = readFileSync(resolve(root, file), 'utf8');
  for (const marker of [
    '/practice.html',
    '/devtools/browser/',
    'frontend/src/apps/practice',
    'baboreborn-local-range-',
    '__matchDiagnostics',
    'Export internal diagnostics',
  ]) {
    if (contents.includes(marker))
      problems.push(`development marker ${marker} included in ${file}`);
  }
}

if (problems.length > 0) {
  throw new Error(
    `Invalid release artifact:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

console.log(
  `Release artifact verified: ${files.length} files, ${productEntries.length} product entries, 0 development surfaces.`,
);
