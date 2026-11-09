import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const updateUrl = process.env.COURSE_HELPER_UPDATE_URL?.trim();
if (updateUrl) {
  const url = new URL(updateUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.endsWith('.user.js')) {
    throw new Error('COURSE_HELPER_UPDATE_URL must be a public HTTPS URL ending in .user.js.');
  }
}
const metadata = [
  '// ==UserScript==',
  '// @name         课程助手 · 倍速与 AI 答题',
  '// @namespace    course-helper',
  `// @version      ${manifest.version}`,
  '// @description  学习通与雨课堂页面内播放控制、倍速、自动下一节和自定义 API 答题。',
  '// @match        https://*.chaoxing.com/*',
  '// @match        https://*.yuketang.cn/*',
  '// @run-at       document-idle',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_deleteValue',
  '// @grant        GM_listValues',
  '// @grant        GM_getTab',
  '// @grant        GM_saveTab',
  '// @grant        GM_addValueChangeListener',
  '// @grant        GM_removeValueChangeListener',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_registerMenuCommand',
  '// @connect      *',
  ...(updateUrl ? [`// @downloadURL  ${updateUrl}`, `// @updateURL    ${updateUrl}`] : []),
  '// ==/UserScript==',
].join('\n');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['userscript.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109'],
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: metadata },
});
for (const folder of ['userscript', 'dist']) {
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, folder, 'course-helper.user.js'), result.outputFiles[0].contents);
}
console.log(`Built userscript/course-helper.user.js and dist/course-helper.user.js (v${manifest.version}).`);
