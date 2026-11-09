import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { compile, deferred, fakeClock, flush } from './helpers.mjs';

const ready = { platform: 'rain', enabled: false, autoNext: false, message: '已找到视频', hasVideo: true, playbackRate: 1 };

async function optionsFixture(t, { granted = true, getResponse } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../options.html', import.meta.url), 'utf8'), {
    url: 'https://extension.invalid/options.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const clock = fakeClock(window);
  const calls = [];
  const permissions = [];
  window.chrome = {
    permissions: { request(value) { permissions.push(value); return Promise.resolve(granted); } },
    runtime: { async sendMessage(request) {
      calls.push(request);
      if (request.action === 'get') return getResponse || { settings: { baseUrl: '', model: '', apiKey: '', autoFill: true } };
      return { message: '连接成功' };
    } },
  };
  window.eval(compile('options.ts'));
  await flush();
  const element = id => window.document.getElementById(id);
  const fill = (url = 'https://api.example/v1') => {
    element('baseUrl').value = url;
    element('model').value = 'test-model';
    element('apiKey').value = 'test-key';
  };
  return { window, clock, calls, permissions, element, fill };
}

test('settings request only the selected API origin before saving', async t => {
  const app = await optionsFixture(t);
  app.fill();
  app.element('saveButton').click();
  assert.deepEqual(JSON.parse(JSON.stringify(app.permissions)), [{ origins: ['https://api.example/*'] }]);
  await flush();
  assert.equal(app.calls[1].action, 'save');
  assert.equal(app.calls[1].settings.apiKey, 'test-key');
  assert.equal(app.element('apiKey').type, 'password');
  assert.match(app.element('status').textContent, /设置已保存/);
});

test('denied API permission does not save credentials or send a test request', async t => {
  const app = await optionsFixture(t, { granted: false });
  app.fill();
  app.element('testButton').click();
  await flush();
  assert.equal(app.calls.length, 1);
  assert.match(app.element('status').textContent, /未授予/);
  assert.equal(app.element('saveButton').disabled, false);
});

test('settings reject credential-bearing and insecure remote URLs', async t => {
  const app = await optionsFixture(t);
  for (const url of ['http://api.example/v1', 'https://name:secret@api.example/v1', 'https://api.example/v1?token=secret']) {
    app.fill(url);
    app.element('saveButton').click();
    await flush();
    assert.equal(app.permissions.length, 0);
    assert.equal(app.element('status').dataset.kind, 'error');
  }
});

test('settings can save and test a local API with no key', async t => {
  const app = await optionsFixture(t);
  app.fill('http://localhost:11434/v1/');
  app.element('apiKey').value = '';
  app.element('testButton').click();
  await flush();
  await flush();
  assert.deepEqual(app.calls.map(call => call.action), ['get', 'save', 'test']);
  assert.equal(app.calls[1].settings.baseUrl, 'http://localhost:11434/v1');
  assert.equal(app.calls[2].settings.apiKey, '');
  assert.equal(app.element('status').textContent, '连接成功');
});

test('disabling automatic filling also disables automatic submission', async t => {
  const app = await optionsFixture(t);
  app.fill();
  assert.equal(app.element('autoSubmit').checked, true);
  app.element('autoFill').click();
  assert.equal(app.element('autoSubmit').checked, false);
  assert.equal(app.element('autoSubmit').disabled, true);
  app.element('saveButton').click();
  await flush();
  assert.equal(app.calls[1].settings.autoFill, false);
  assert.equal(app.calls[1].settings.autoSubmit, false);
});

test('changing API preset clears the previous destination credentials', async t => {
  const app = await optionsFixture(t);
  app.fill();
  app.window.document.querySelector('[data-preset]').click();
  assert.equal(app.element('apiKey').value, '');
  assert.equal(app.element('model').value, '');
  assert.equal(app.permissions.length, 0);
});

test('late settings load cannot overwrite a newly edited and saved configuration', async t => {
  const previous = deferred();
  const app = await optionsFixture(t, { getResponse: previous.promise });
  app.fill();
  app.element('baseUrl').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  app.element('saveButton').click();
  await flush();
  previous.resolve({ settings: { baseUrl: 'https://old.example/v1', model: 'old-model', apiKey: 'old-key' } });
  await flush();
  assert.equal(app.element('baseUrl').value, 'https://api.example/v1');
  assert.equal(app.element('apiKey').value, 'test-key');
  assert.match(app.element('status').textContent, /设置已保存/);
});

async function panelFixture(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://www.yuketang.cn/test', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const clock = fakeClock(window);
  let shadow;
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  window.module = { exports: {} };
  window.eval(transformSync(readFileSync(new URL('../ui.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code);
  const calls = [];
  window.module.exports.mountPanel(message => {
    const pending = deferred();
    calls.push({ message, ...pending });
    return pending.promise;
  });
  assert.equal(window.document.getElementById('course-helper-panel').shadowRoot, null);
  calls[0].resolve(ready);
  calls[1].resolve({ status: 'idle' });
  await flush();
  return { window, clock, calls, shadow, element: id => shadow.getElementById(id) };
}

test('page panel routes playback speed and stays isolated from page CSS', async t => {
  const app = await panelFixture(t);
  app.element('rate').value = '2';
  app.element('rate').dispatchEvent(new app.window.Event('change'));
  assert.equal(app.calls[2].message.action, 'setPlaybackRate');
  assert.equal(app.calls[2].message.playbackRate, 2);
  app.calls[2].resolve({ ...ready, playbackRate: 2 });
  await flush();
  assert.equal(app.element('rate').value, '2');
});

test('page panel renders AI results as text and can cancel a running job', async t => {
  const app = await panelFixture(t);
  app.element('quiz').click();
  assert.equal(app.calls[2].message.action, 'quizRun');
  app.calls[2].resolve({ status: 'running', message: '处理中' });
  await flush();
  assert.equal(app.element('cancel').hidden, false);
  app.element('cancel').click();
  assert.equal(app.calls[3].message.action, 'quizCancel');
  app.calls[3].resolve({ status: 'cancelled', message: '已停止', results: [{ answer: '<img src=x>', explanation: '<script>bad</script>' }] });
  await flush();
  assert.equal(app.element('resultList').querySelector('img'), null);
  assert.match(app.element('resultList').textContent, /<img src=x>/);
  assert.equal(app.element('quiz').disabled, false);
});

test('page panel collapses without losing the running controls', async t => {
  const app = await panelFixture(t);
  app.element('collapse').click();
  assert.equal(app.element('shell').hidden, true);
  assert.equal(app.element('launcher').getAttribute('aria-expanded'), 'false');
  app.element('launcher').click();
  assert.equal(app.element('shell').hidden, false);
  assert.equal(app.element('launcher').getAttribute('aria-expanded'), 'true');
});
