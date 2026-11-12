import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

// Resolve from this script so the check works from any working directory.
// Only application files are checked; bundled vendor code is excluded.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
for (const [directory, extension] of [['web', '.js'], ['scripts', '.mjs']]) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(extension)) files.push(join(root, directory, entry.name));
  }
}

let failures = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    failures += 1;
    console.error(`Syntax check failed: ${relative(root, file)}${result.error ? ` (${result.error.message})` : ''}`);
  }
}
console.log(`Syntax checks: ${files.length - failures}/${files.length} passed.`);
if (failures) process.exitCode = 1;
