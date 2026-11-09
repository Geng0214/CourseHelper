import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { compile, deferred, fakeClock, flush } from './helpers.mjs';

const ready = { platform: 'rain', enabled: false, autoNext: false, message: '可以开始', hasVideo: true };

async function fixture(t, { tabs = [{ id: 12 }] } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../popup.html', import.meta.url), 'utf8'), {
    url: 'https://extension.invalid/popup.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const clock = fakeClock(window);
  const calls = [];
  window.chrome = {
    tabs: { query: async () => tabs },
    runtime: {
      sendMessage(request) {
        const pending = deferred();
        calls.push({ request, ...pending });
        return pending.promise;
      },
    },
  };
  window.eval(compile('popup.ts'));
  await flush();
  return { window, clock, calls, element: id => window.document.querySelector(`#${id}`) };
}

test('popup routes to the background and detects the platform automatically', async t => {
  const app = await fixture(t);
  assert.equal(app.calls[0].request.type, 'courseHelperPopup');
  assert.equal(app.calls[0].request.tabId, 12);
  app.calls[0].resolve(ready);
  await flush();
  assert.equal(app.element('platformName').textContent, '雨课堂 · 已连接');
  assert.equal(app.element('startButton').disabled, false);
  assert.equal(app.element('pauseButton').disabled, true);
  assert.equal(app.element('autoNextCheckbox').checked, false);
});

test('polling does not block user commands or overwrite newer command state', async t => {
  const app = await fixture(t);
  app.calls[0].resolve(ready);
  await flush();
  await app.clock.tick(1500);
  assert.equal(app.element('startButton').disabled, false);
  app.element('startButton').click();
  assert.equal(app.calls[2].request.action, 'start');
  app.calls[2].resolve({ ...ready, enabled: true, message: '正在播放' });
  await flush();
  app.calls[1].resolve({ ...ready, message: '旧轮询状态' });
  await flush();
  assert.equal(app.element('statusText').textContent, '正在播放');
  assert.equal(app.element('pauseButton').disabled, false);
});

test('no-video state disables playback but leaves automatic-next preference editable', async t => {
  const app = await fixture(t);
  app.calls[0].resolve({ ...ready, hasVideo: false, message: '请进入视频章节' });
  await flush();
  assert.equal(app.element('startButton').disabled, true);
  assert.equal(app.element('autoNextCheckbox').disabled, false);
  assert.equal(app.element('statusText').textContent, '请进入视频章节');
});

test('invalid responses offer an actionable reconnect path', async t => {
  const app = await fixture(t);
  app.calls[0].resolve({ unexpected: true });
  await flush();
  assert.equal(app.element('retryButton').hidden, false);
  assert.equal(app.element('retryButton').disabled, false);
  assert.match(app.element('statusText').textContent, /首次安装或更新/);
  app.element('retryButton').click();
  await flush();
  app.calls[1].resolve(ready);
  await flush();
  assert.equal(app.element('startButton').disabled, false);
  assert.equal(app.element('retryButton').hidden, true);
});

test('pause failures preserve the background explanation as plain text', async t => {
  const app = await fixture(t);
  app.calls[0].resolve({ ...ready, enabled: true });
  await flush();
  app.element('pauseButton').click();
  assert.equal(app.calls[1].request.action, 'pause');
  const error = '未能确认暂停，请在网页播放器中暂停。<img src=x>';
  app.calls[1].resolve({ error });
  await flush();
  assert.equal(app.element('statusText').textContent, error);
  assert.equal(app.element('statusText').querySelector('img'), null);
  assert.equal(app.element('retryButton').hidden, false);
});

test('a connection timeout releases controls and ignores a late response', async t => {
  const app = await fixture(t);
  await app.clock.tick(8000);
  assert.equal(app.element('retryButton').disabled, false);
  assert.equal(app.element('retryButton').hidden, false);
  app.calls[0].resolve(ready);
  await flush();
  assert.equal(app.element('startButton').disabled, true);
});

test('automatic-next changes send the actual checkbox value', async t => {
  const app = await fixture(t);
  app.calls[0].resolve(ready);
  await flush();
  app.element('autoNextCheckbox').click();
  assert.equal(app.calls[1].request.action, 'setAutoNext');
  assert.equal(app.calls[1].request.autoNext, true);
  app.calls[1].resolve({ ...ready, autoNext: true });
  await flush();
  assert.equal(app.element('autoNextCheckbox').checked, true);
});

test('a missing active tab offers reconnect without sending a command', async t => {
  const app = await fixture(t, { tabs: [] });
  assert.equal(app.calls.length, 0);
  assert.equal(app.element('retryButton').disabled, false);
  assert.match(app.element('statusText').textContent, /没有找到当前标签页/);
});
