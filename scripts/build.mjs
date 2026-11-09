import { build } from 'esbuild';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const extensionDirectory = path.join(projectRoot, 'extension');

// Only delete directories created by this build inside this project. Refuse links.
async function removeBuildDirectory(directory) {
  const resolved = path.resolve(directory);
  const relative = path.relative(projectRoot, resolved);
  if (path.dirname(resolved) !== path.resolve(projectRoot)
      || (relative !== 'extension' && !relative.startsWith('.build-'))) {
    throw new Error(`Refusing to remove unexpected build path: ${resolved}`);
  }
  const stat = await lstat(resolved).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error(`Build directory must not be a symbolic link: ${resolved}`);
  if (stat) await rm(resolved, { recursive: true, force: true });
}

export async function buildExtension() {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
    throw new Error('manifest.json must contain Manifest V3 and a numeric version.');
  }
  const staging = await mkdtemp(path.join(projectRoot, '.build-'));
  try {
    await build({
      absWorkingDir: projectRoot,
      entryPoints: ['content.ts', 'popup.ts', 'background.ts', 'options.ts'],
      outdir: staging,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome109'],
      charset: 'utf8',
      legalComments: 'none',
      sourcemap: false,
      logLevel: 'warning',
    });
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const popup = await readFile(path.join(projectRoot, 'popup.html'), 'utf8');
    await writeFile(path.join(staging, 'popup.html'), popup.replace(/\r\n/g, '\n'));
    const options = await readFile(path.join(projectRoot, 'options.html'), 'utf8');
    await writeFile(path.join(staging, 'options.html'), options.replace(/\r\n/g, '\n'));
    const iconDirectory = path.join(projectRoot, 'icons');
    const icons = await lstat(iconDirectory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (icons) {
      if (!icons.isDirectory() || icons.isSymbolicLink()) throw new Error('icons must be a regular directory.');
      await cp(iconDirectory, path.join(staging, 'icons'), { recursive: true });
    }
    const referenced = [
      manifest.action?.default_popup,
      manifest.options_ui?.page,
      manifest.background?.service_worker,
      ...Object.values(manifest.icons ?? {}),
      ...(typeof manifest.action?.default_icon === 'string'
        ? [manifest.action.default_icon]
        : Object.values(manifest.action?.default_icon ?? {})),
      ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    ].filter(Boolean);
    for (const file of referenced) {
      const candidate = path.resolve(staging, file);
      if (path.relative(staging, candidate).startsWith('..') || path.isAbsolute(file)) {
        throw new Error(`Manifest references an unsafe asset path: ${file}`);
      }
      if (!(await lstat(candidate)).isFile()) throw new Error(`Missing manifest asset: ${file}`);
    }
    await removeBuildDirectory(extensionDirectory);
    await mkdir(extensionDirectory, { recursive: true });
    for (const file of await readdir(staging)) {
      await cp(path.join(staging, file), path.join(extensionDirectory, file), { recursive: true });
    }
    console.log(`Built extension/ (v${manifest.version}).`);
    return manifest;
  } finally {
    await removeBuildDirectory(staging);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExtension();
}
