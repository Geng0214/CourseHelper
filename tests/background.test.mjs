import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compile } from './helpers.mjs';

const baseStatus = (extra = {}) => ({ platform: 'rain', enabled: false, autoNext: false,
  message: '就绪', hasVideo: true, videoArea: 640 * 360, ...extra });

function routerHarness({ frames, states = {}, send, sender, frameError } = {}) {
  frames ??= [{ frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' }];
  const calls = [];
  let handler;
  const chrome = {
    runtime: { id: 'test-course-helper', onMessage: { addListener(listener) { handler = listener; } } },
    webNavigation: { async getAllFrames({ tabId }) {
      calls.push({ method: 'getAllFrames', tabId });
      if (frameError) throw frameError;
      return frames;
    } },
    tabs: { async sendMessage(tabId, message, { frameId }) {
      calls.push({ method: 'sendMessage', tabId, frameId, ...message });
      if (send) return send(frameId, message, states);
      const status = states[frameId];
      if (!status) throw new Error('No receiver');
      if (message.action === 'start') status.enabled = true;
      if (message.action === 'pause') status.enabled = false;
      if (message.action === 'setAutoNext') status.autoNext = message.autoNext;
      return { ...status };
    } },
  };
  vm.runInNewContext(compile('background.ts'), { chrome, URL, setTimeout, clearTimeout, console });
  return {
    calls,
    async message(action = 'getStatus', extra = {}, senderOverride) {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Router did not respond')), 2500);
        const accepted = handler({ type: 'courseHelperPopup', tabId: 7, action, ...extra },
          senderOverride || sender || { id: 'test-course-helper', url: 'chrome-extension://test-course-helper/popup.html' },
          value => { clearTimeout(timeout); resolve(value); });
        if (accepted !== true) { clearTimeout(timeout); resolve(undefined); }
      });
    },
  };
}

test('router finds a supported cross-origin player frame and routes start to it', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://mooc1.chaoxing.com/course' },
    { frameId: 2, parentFrameId: 0, url: 'https://mooc1-1.chaoxing.com/player' },
  ], states: {
    0: baseStatus({ platform: 'chaoxing', hasVideo: false, videoArea: 0 }),
    2: baseStatus({ platform: 'chaoxing' }),
  } });
  assert.equal((await app.message('start')).enabled, true);
  assert.deepEqual(app.calls.filter(call => call.action === 'start').map(call => call.frameId), [2]);
});

test('router prefers the enabled player even if another video is larger', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://player.yuketang.cn/video' },
  ], states: { 0: baseStatus({ videoArea: 999999 }), 1: baseStatus({ enabled: true, videoArea: 100, message: 'active' }) } });
  assert.equal((await app.message()).message, 'active');
});

test('router chooses the largest visible video when none are active', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://player.yuketang.cn/video' },
  ], states: { 0: baseStatus({ videoArea: 100 }), 1: baseStatus({ videoArea: 999999, message: 'large' }) } });
  assert.equal((await app.message()).message, 'large');
});

test('router never commands a different platform or unrelated frame', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://mooc1.chaoxing.com/video' },
    { frameId: 2, parentFrameId: 0, url: 'https://ads.example/video' },
  ], states: { 0: baseStatus(), 1: baseStatus({ platform: 'chaoxing' }), 2: baseStatus() } });
  await app.message('start');
  assert.equal(app.calls.filter(call => call.method === 'sendMessage').every(call => call.frameId === 0), true);
});

test('unsupported top-level pages cannot control an embedded course player', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://unrelated.example/' },
    { frameId: 2, parentFrameId: 0, url: 'https://www.yuketang.cn/video' },
  ], states: { 2: baseStatus() } });
  assert.match((await app.message('start')).error, /学习通|雨课堂/);
  assert.equal(app.calls.some(call => call.method === 'sendMessage'), false);
});

test('lookalike and insecure platform domains are rejected', async () => {
  for (const url of ['https://www.yuketang.cn.attacker.example/', 'http://www.yuketang.cn/', 'https://fakechaoxing.com/']) {
    const app = routerHarness({ frames: [{ frameId: 0, parentFrameId: -1, url }], states: { 0: baseStatus() } });
    assert.ok((await app.message('start')).error);
    assert.equal(app.calls.some(call => call.method === 'sendMessage'), false);
  }
});

test('pause reaches every active frame', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://player.yuketang.cn/video' },
  ], states: { 0: baseStatus({ enabled: true }), 1: baseStatus({ enabled: true }) } });
  assert.equal((await app.message('pause')).enabled, false);
  assert.deepEqual(app.calls.filter(call => call.action === 'pause').map(call => call.frameId).sort(), [0, 1]);
});

test('pause does not report full success if one active frame fails', async () => {
  const app = routerHarness({ frames: [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://player.yuketang.cn/video' },
  ], states: { 0: baseStatus({ enabled: true }), 1: baseStatus({ enabled: true }) },
  send(frameId, message, states) {
    if (message.action === 'pause' && frameId === 1) throw new Error('Player disconnected');
    return { ...states[frameId], enabled: message.action === 'pause' ? false : true };
  } });
  const result = await app.message('pause');
  assert.ok(result.error || /部分|未能|失败/.test(result.message));
});

test('missing content script gives install/refresh guidance', async () => {
  const app = routerHarness();
  assert.match((await app.message()).error, /刷新/);
});

test('a malformed player status is excluded', async () => {
  const app = routerHarness({ states: { 0: baseStatus({ videoArea: NaN }) } });
  assert.ok((await app.message()).error);
});

test('a route platform mismatch cannot start a player', async () => {
  const app = routerHarness({ states: { 0: baseStatus() } });
  await app.message('start', { platform: 'chaoxing' });
  assert.equal(app.calls.some(call => call.action === 'start'), false);
});

test('content scripts and foreign extensions cannot invoke popup routing', async () => {
  const app = routerHarness({ states: { 0: baseStatus() } });
  assert.equal(await app.message('start', {}, { id: 'test-course-helper', tab: { id: 7 } }), undefined);
  assert.equal(await app.message('start', {}, { id: 'other-extension' }), undefined);
  assert.equal(app.calls.length, 0);
});

test('invalid tab IDs and actions are ignored', async () => {
  const app = routerHarness({ states: { 0: baseStatus() } });
  assert.equal(await app.message('start', { tabId: -1 }), undefined);
  assert.equal(await app.message('start', { tabId: 1.5 }), undefined);
  assert.equal(await app.message('submitAnswers'), undefined);
  assert.equal(app.calls.length, 0);
});

test('closed tab errors produce a useful error response', async () => {
  const app = routerHarness({ frameError: new Error('No tab with id') });
  assert.match((await app.message()).error, /连接|刷新/);
});

test('pause still reaches a frame whose status discovery failed', async () => {
  const app = routerHarness({ send(_frameId, message) {
    if (message.action === 'getStatus') throw new Error('Discovery connection interrupted');
    return baseStatus({ enabled: false });
  } });
  assert.equal((await app.message('pause')).enabled, false);
  assert.deepEqual(app.calls.filter(call => call.action === 'pause').map(call => call.frameId), [0]);
});

test('pause ignores confirmed absent controllers but not unknown failures', async () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course' },
    { frameId: 1, parentFrameId: 0, url: 'https://www.yuketang.cn/same-origin-child' },
  ];
  for (const absentMessage of ['Could not establish connection. Receiving end does not exist.', 'No matching message handler']) {
    const app = routerHarness({ frames, send(frameId, message) {
      if (frameId === 1) throw new Error(absentMessage);
      return baseStatus({ enabled: message.action !== 'pause' });
    } });
    assert.equal((await app.message('pause')).enabled, false);
    assert.deepEqual(app.calls.filter(call => call.action === 'pause').map(call => call.frameId).sort(), [0, 1]);
  }
});
