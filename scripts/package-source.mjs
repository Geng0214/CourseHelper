import { zipSync } from 'fflate';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension, projectRoot } from './build.mjs';

// An explicit allowlist keeps local downloads, credentials and dependencies out
// of the source archive. Add new repository files here deliberately.
const requiredFiles = [
  'background.ts', 'chromeTypes.d.ts', 'content.ts', 'popup.ts', 'popup.html',
  'api.ts', 'quiz-jobs.ts', 'controller.ts', 'quiz.ts', 'ui.ts', 'options.ts', 'options.html', 'userscript.ts',
  'manifest.json', 'package.json', 'package-lock.json', 'tsconfig.json',
  'README.md', 'PRIVACY.md', 'CHANGELOG.md', '.gitignore', '.gitattributes',
];
const optionalFiles = ['LICENSE', 'LICENSE.md'];
const sourceDirectories = ['.github', 'scripts', 'tests', 'docs', 'icons', 'extension', 'userscript'];
const allowedExtensions = new Set(['.ts', '.mjs', '.js', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.png', '.svg']);
const manifest = await buildExtension();
const entries = {};
const timestamp = new Date(2020, 0, 1, 0, 0, 0);

async function includeFile(relative) {
  const source = path.resolve(projectRoot, relative);
  if (path.relative(projectRoot, source).startsWith('..')) throw new Error(`Unsafe source path: ${relative}`);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular source file: ${relative}`);
  entries[relative.replaceAll(path.sep, '/')] = [new Uint8Array(await readFile(source)), { mtime: timestamp }];
}

async function collectDirectory(relative) {
  const directory = path.join(projectRoot, relative);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a regular source directory: ${relative}`);
  const files = await readdir(directory, { withFileTypes: true });
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (file.isSymbolicLink()) throw new Error(`Refusing to package a symbolic link: ${relative}/${file.name}`);
    if (file.name.startsWith('.') || ['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report'].includes(file.name)) continue;
    const target = path.join(relative, file.name);
    if (file.isDirectory()) await collectDirectory(target);
    else if (file.isFile() && allowedExtensions.has(path.extname(file.name))) await includeFile(target);
  }
}

for (const file of requiredFiles) await includeFile(file);
for (const file of optionalFiles) {
  const exists = await lstat(path.join(projectRoot, file)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (exists) await includeFile(file);
}
for (const directory of sourceDirectories) await collectDirectory(directory);

const distribution = path.join(projectRoot, 'dist');
await mkdir(distribution, { recursive: true });
const filename = `course-helper-source-v${manifest.version}.zip`;
const archive = zipSync(entries, { level: 9 });
await writeFile(path.join(distribution, filename), archive);
console.log(`Packaged dist/${filename} (${Object.keys(entries).length} files, ${archive.length.toLocaleString('en')} bytes).`);
