import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compile } from './helpers.mjs';

const settings = { baseUrl: 'https://mock.example/v1', apiKey: 'test-secret-never-log', model: 'mock-model', autoFill: true, autoSubmit: true };
function harness({ allowed = true, saved = settings, fetcher } = {}) {
  let listener; const commands = []; const requests = []; const local = { apiSettings: saved }; const session = {};
  const area = data => ({ async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); }, async setAccessLevel(options) { commands.push({ access: options }); } });
  const q = { id: 'd0:q1', type: 'single', text: '1+1等于多少', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }] };
  const chrome = {
    runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}`, onMessage: { addListener(fn) { listener = fn; } }, async openOptionsPage() { commands.push({ openOptions: true }); } },
    permissions: { async contains(arg) { commands.push({ permission: arg }); return allowed; } },
    storage: { local: area(local), session: area(session) },
    webNavigation: { async getAllFrames({ tabId }) { commands.push({ frames: tabId }); return [{ frameId: 0, url: 'https://www.yuketang.cn/course' }]; } },
    tabs: { async sendMessage(tabId, request, { frameId }) {
      commands.push({ tabId, frameId, ...request });
      if (request.action === 'getQuiz') return { questions: [q], skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: 1, skipped: 0, errors: [] };
      if (request.action === 'submitQuiz') return { submitted: true, confirmed: true, message: '页面显示提交成功。' };
      return { platform: 'rain', enabled: false, autoNext: false, message: '就绪', hasVideo: false, videoArea: 0 };
    } },
  };
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (fetcher) return fetcher(url, init);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ answers: [{ id: q.id, optionIds: ['B'] }] }) } }] }; } };
  };
  vm.runInNewContext(compile('background.ts'), { chrome, URL, setTimeout, clearTimeout, AbortController, structuredClone, fetch, console });
  async function message(value, sender = { id: 'test', url: 'chrome-extension://test/options.html' }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No response')), 2000);
      const accept = listener(value, sender, result => { clearTimeout(timer); resolve(result); });
      if (accept !== true) { clearTimeout(timer); resolve(undefined); }
    });
  }
  return { commands, requests, local, session, message };
}

test('API settings and secrets are only returned to the options document', async () => {
  const app = harness();
  const request = { type: 'courseHelperSettings', action: 'get' };
  assert.equal((await app.message(request)).settings.apiKey, settings.apiKey);
  assert.equal((await app.message(request, { id: 'test', url: 'chrome-extension://test/options.html', tab: { id: 4 }, frameId: 0 })).settings.apiKey, settings.apiKey);
  for (const sender of [
    { id: 'test', url: 'https://www.yuketang.cn/', tab: { id: 1 }, frameId: 0 },
    { id: 'test', url: 'chrome-extension://test/popup.html' },
    { id: 'other', url: 'chrome-extension://test/options.html' },
  ]) assert.equal(await app.message(request, sender), undefined);
  assert.equal(app.commands[0].access.accessLevel, 'TRUSTED_CONTEXTS');
});

test('saving API configuration requires granted origin access', async () => {
  const app = harness({ allowed: false });
  const result = await app.message({ type: 'courseHelperSettings', action: 'save', settings: { ...settings, model: 'changed' } });
  assert.match(result.error, /权限/); assert.equal(app.local.apiSettings.model, 'mock-model');
  assert.equal(app.requests.length, 0);
});

test('API test sends credentials only to the normalized configured endpoint', async () => {
  const app = harness({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }) });
  const response = await app.message({ type: 'courseHelperSettings', action: 'test', settings });
  assert.match(response.message, /成功/);
  assert.equal(app.requests[0].url, 'https://mock.example/v1/chat/completions');
  assert.equal(app.requests[0].init.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(app.requests[0].init.credentials, 'omit'); assert.equal(app.requests[0].init.redirect, 'error');
});

test('page panel uses sender tab ID and completes AI fill and submit via the background', async () => {
  const app = harness();
  const sender = { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://www.yuketang.cn/course' };
  const started = await app.message({ type: 'courseHelperPanel', action: 'quizRun', tabId: 999 }, sender);
  assert.equal(started.status, 'running');
  let state;
  for (let n = 0; n < 30; n++) {
    state = await app.message({ type: 'courseHelperPanel', action: 'quizStatus' }, sender);
    if (state.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.status, 'done'); assert.match(state.message, /提交成功/);
  assert(app.commands.some(c => c.action === 'applyAnswers')); assert(app.commands.some(c => c.action === 'submitQuiz'));
  assert(app.commands.filter(c => c.tabId !== undefined).every(c => c.tabId === 7));
  assert(!JSON.stringify(app.session).includes(settings.apiKey));
});

test('an embedded frame cannot impersonate the page panel', async () => {
  const app = harness();
  assert.equal(await app.message({ type: 'courseHelperPanel', action: 'quizRun' }, { id: 'test', tab: { id: 7 }, frameId: 2, url: 'https://www.yuketang.cn/course' }), undefined);
  assert.equal(app.requests.length, 0);
});

test('options can be opened even from a page that has no course player', async () => {
  const app = harness();
  const result = await app.message({ type: 'courseHelperPopup', tabId: 7, action: 'openOptions' }, { id: 'test', url: 'chrome-extension://test/popup.html' });
  assert.match(result.message, /已打开/); assert(app.commands.some(c => c.openOptions));
});

test('cancellation after a worker restart reaches the saved job in content scripts', async () => {
  const app = harness();
  app.session['quizJob:7'] = { jobId: 'before-restart', status: 'running', message: '提交中', completed: 1, total: 1, results: [] };
  const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const stopped = await app.message({ type: 'courseHelperPopup', action: 'quizCancel', tabId: 7 }, sender);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(app.session['quizJob:7'].status, 'cancelled');
  const cancellation = app.commands.find(command => command.action === 'cancelQuiz');
  assert.equal(cancellation.jobId, 'before-restart');
  assert.equal(cancellation.frameId, 0);
});

test('reading an interrupted job automatically stops surviving confirmation steps', async () => {
  const app = harness();
  app.session['quizJob:7'] = { jobId: 'before-restart', status: 'running', message: '提交中', completed: 1, total: 1, results: [] };
  const recovered = await app.message({ type: 'courseHelperPopup', action: 'quizStatus', tabId: 7 }, { id: 'test', url: 'chrome-extension://test/popup.html' });
  assert.equal(recovered.status, 'error');
  assert.match(recovered.message, /后台已重启/);
  assert.equal(app.session['quizJob:7'].status, 'error');
  assert.equal(app.commands.find(command => command.action === 'cancelQuiz').jobId, 'before-restart');
});
