import { zipSync } from 'fflate';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension, extensionDirectory, projectRoot } from './build.mjs';

const manifest = await buildExtension();
const entries = {};
// ZIP stores local calendar fields; use the same local fields in every timezone.
const fixedTimestamp = new Date(2020, 0, 1, 0, 0, 0);

async function collect(directory, prefix = '') {
  const files = await readdir(directory, { withFileTypes: true });
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const source = path.join(directory, file.name);
    const name = prefix + file.name;
    if (file.isSymbolicLink()) throw new Error(`Refusing to package a symbolic link: ${name}`);
    if (file.isDirectory()) await collect(source, `${name}/`);
    else if (file.isFile()) entries[name] = [new Uint8Array(await readFile(source)), { mtime: fixedTimestamp }];
  }
}

await collect(extensionDirectory);
const distribution = path.join(projectRoot, 'dist');
await mkdir(distribution, { recursive: true });
const filename = `course-helper-v${manifest.version}.zip`;
const archive = zipSync(entries, { level: 9 });
await writeFile(path.join(distribution, filename), archive);
console.log(`Packaged dist/${filename} (${archive.length.toLocaleString('en')} bytes).`);
