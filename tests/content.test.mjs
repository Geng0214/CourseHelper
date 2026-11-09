import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, contentHarness, deferred, flush } from './helpers.mjs';

function fixture(t, options) {
  const app = contentHarness(options);
  t.after(() => app.close());
  return app;
}

test('does not start a video until the user requests playback', async t => {
  const app = fixture(t);
  await app.clock.tick(5000);
  const status = await app.message('getStatus');
  assert.equal(status.enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('start and pause operate on the detected video', async t => {
  const app = fixture(t);
  const media = [...app.media.values()][0];
  await app.message('start');
  assert.equal(media.playCalls, 1);
  assert.equal((await app.message('getStatus')).enabled, true);
  await app.message('pause');
  assert.equal(media.paused, true);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('a mismatched platform cannot start playback', async t => {
  const app = fixture(t);
  const status = await app.message('start', { platform: 'chaoxing' });
  assert.equal(status.enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('a page without a video stays stopped with actionable feedback', async t => {
  const app = fixture(t, { html: '<main>课程目录</main>' });
  const status = await app.message('start');
  assert.equal(status.enabled, false);
  assert.match(status.message, /视频/);
});

test('hidden videos are never chosen for playback', async t => {
  const app = fixture(t, { html: '<div hidden><video></video></div><video id="visible"></video>' });
  await app.message('start');
  assert.equal(app.media.get(app.document.querySelector('div video')).playCalls, 0);
  assert.equal(app.media.get(app.document.querySelector('#visible')).playCalls, 1);
});

test('a play promise resolving after pause cannot restart playback', async t => {
  const app = fixture(t);
  const media = [...app.media.values()][0];
  const pending = deferred();
  media.playResult = pending.promise;
  await app.message('start');
  await app.message('pause');
  // Some players update playback state only when their pending play resolves.
  media.paused = false;
  pending.resolve();
  await flush();
  assert.equal(media.paused, true);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('play rejection stops helper and explains browser playback restrictions', async t => {
  const app = fixture(t);
  [...app.media.values()][0].playResult = () => Promise.reject(new Error('NotAllowedError'));
  await app.message('start');
  const status = await app.message('getStatus');
  assert.equal(status.enabled, false);
  assert.match(status.message, /播放/);
});

test('manual pause in the page stops automatic playback', async t => {
  const app = fixture(t);
  await app.message('start');
  app.document.querySelector('video').pause();
  await app.clock.tick(2000);
  assert.equal((await app.message('getStatus')).enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 1);
});

test('media loading error stops helper', async t => {
  const app = fixture(t);
  await app.message('start');
  app.document.querySelector('video').dispatchEvent(new app.window.Event('error'));
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('normal video end with auto-next off stops helper', async t => {
  const app = fixture(t);
  await app.message('start');
  [...app.media.values()][0].finish();
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('turning auto-next off cancels an already queued transition', async t => {
  const app = fixture(t, { html: '<video></video><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div><div id="next" class="leaf-item"><span class="leaf-item-tag">视频</span></div>' });
  let clicks = 0;
  app.document.querySelector('#next').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(1000);
  await app.message('setAutoNext', { autoNext: false });
  await app.clock.tick(5000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('a changed course stops the helper instead of following the new course', async t => {
  const app = fixture(t);
  await app.message('start');
  app.window.history.pushState({}, '', '/v2/web/studentLog/456/video/2');
  await app.clock.tick(2000);
  const status = await app.message('getStatus');
  assert.equal(status.enabled, false);
  assert.match(status.message, /课程|切换/);
});

test('removing the playing video eventually stops with feedback', async t => {
  const app = fixture(t);
  await app.message('start');
  app.document.querySelector('video').remove();
  await app.clock.tick(18000);
  const status = await app.message('getStatus');
  assert.equal(status.enabled, false);
  assert.match(status.message, /视频/);
});

test('corrupt stored state does not crash content script or auto-start', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: '{invalid json' } });
  const status = await app.message('getStatus');
  assert.equal(status.enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('messages outside the extension protocol do not change playback', async t => {
  const app = fixture(t);
  let responded = false;
  for (const listener of app.listeners) {
    listener({ type: 'unrelated', action: 'start' }, {}, () => { responded = true; });
  }
  assert.equal(responded, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('auto-next waits for the page progress before opening the next rain video', async t => {
  const app = fixture(t, { html: '<video></video><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div><div id="next" class="leaf-item"><span class="leaf-item-tag">视频</span></div>' });
  let clicks = 0;
  app.document.querySelector('#next').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(2000);
  assert.equal(clicks, 0);
  await app.clock.tick(1500);
  assert.equal(clicks, 1);
});

test('auto-next stops at a rain exercise instead of opening it', async t => {
  const app = fixture(t, { html: '<video></video><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div><div id="next" class="leaf-item"><span class="leaf-item-tag">练习</span></div>' });
  let clicks = 0;
  app.document.querySelector('#next').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('auto-next stops at a locked rain video', async t => {
  const app = fixture(t, { html: '<video></video><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div><div id="next" class="leaf-item is-disabled"><span class="leaf-item-tag">视频</span></div>' });
  let clicks = 0;
  app.document.querySelector('#next').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('chaoxing unfinished chapter tasks block next navigation', async t => {
  const app = fixture(t, {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=10&clazzid=20',
    html: '<video></video><div id="coursetree"><h4 class="currents"><span class="jobCount">1</span></h4><h4></h4></div><button id="right1">下一节</button>',
  });
  let clicks = 0;
  app.document.querySelector('#right1').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('chaoxing completed chapter can open the next chapter', async t => {
  const app = fixture(t, {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=10&clazzid=20',
    html: '<video></video><div id="coursetree"><h4 class="currents"><span class="jobCount">0</span></h4><h4></h4></div><button id="right1">下一节</button>',
  });
  let clicks = 0;
  app.document.querySelector('#right1').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 1);
});

test('legacy enabled state does not restart playback after a reload', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: JSON.stringify({
    enabled: true, autoNext: true, courseKey: 'https://www.yuketang.cn/classroom/123',
  }) } });
  assert.equal((await app.message('getStatus')).enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('expired continuation does not restart playback', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: JSON.stringify({
    enabled: true, autoNext: true, courseKey: 'https://www.yuketang.cn/classroom/123', resumeUntil: 9999,
  }) } });
  assert.equal((await app.message('getStatus')).enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('fresh same-course continuation resumes once and is consumed', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: JSON.stringify({
    enabled: true, autoNext: true, courseKey: 'https://www.yuketang.cn/classroom/123', resumeUntil: 25000,
  }) } });
  assert.equal((await app.message('getStatus')).enabled, true);
  assert.equal([...app.media.values()][0].playCalls, 1);
  const saved = app.window.sessionStorage.getItem('courseHelperRainState');
  const reloaded = fixture(t, { storage: { courseHelperRainState: saved } });
  assert.equal((await reloaded.message('getStatus')).enabled, false);
  assert.equal([...reloaded.media.values()][0].playCalls, 0);
});

test('continuation cannot start a different course', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: JSON.stringify({
    enabled: true, autoNext: true, courseKey: 'https://www.yuketang.cn/classroom/999', resumeUntil: 25000,
  }) } });
  assert.equal((await app.message('getStatus')).enabled, false);
  assert.equal([...app.media.values()][0].playCalls, 0);
});

test('auto-next preference survives multiple idle page reloads', async t => {
  const app = fixture(t, { storage: { courseHelperRainState: JSON.stringify({
    enabled: false, autoNext: true, courseKey: '', resumeUntil: 0,
  }) } });
  assert.equal((await app.message('getStatus')).autoNext, true);
  const saved = app.window.sessionStorage.getItem('courseHelperRainState');
  const reloaded = fixture(t, { storage: saved ? { courseHelperRainState: saved } : {} });
  assert.equal((await reloaded.message('getStatus')).autoNext, true);
});

test('unknown-course SPA navigation cannot inherit active playback', async t => {
  const app = fixture(t, { url: 'https://www.yuketang.cn/unknown/player?item=1' });
  await app.message('start');
  app.window.history.pushState({}, '', '/unknown/player?item=2');
  await app.clock.tick(2000);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('completed exercise still blocks rain auto-next', async t => {
  const app = fixture(t, { html: '<video></video><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div><div class="leaf-item"><span class="leaf-item-tag">练习</span><i class="yuanquangou"></i></div><div id="next" class="leaf-item"><span class="leaf-item-tag">视频</span></div>' });
  let clicks = 0;
  app.document.querySelector('#next').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('rain auto-next does not jump into a separate directory', async t => {
  const app = fixture(t, { html: '<video></video><section><div class="leaf-item is-active"><span class="leaf-item-tag">视频</span></div></section><section><div id="unrelated" class="leaf-item"><span class="leaf-item-tag">视频</span></div></section>' });
  let clicks = 0;
  app.document.querySelector('#unrelated').addEventListener('click', () => clicks++);
  await app.message('setAutoNext', { autoNext: true });
  await app.message('start');
  [...app.media.values()][0].finish();
  await app.clock.tick(4000);
  assert.equal(clicks, 0);
  assert.equal((await app.message('getStatus')).enabled, false);
});

test('same-origin child frames do not create duplicate controllers', t => {
  const app = fixture(t, { html: '<iframe src="https://www.yuketang.cn/player"></iframe>' });
  const child = app.document.querySelector('iframe').contentWindow;
  let listeners = 0;
  child.chrome = { runtime: { onMessage: { addListener() { listeners++; } } } };
  child.eval(compile('content.ts'));
  assert.equal(listeners, 0);
});

test('cross-origin child frames register their own controller', t => {
  const app = fixture(t, { html: '<iframe src="https://player.yuketang.cn/video"></iframe>' });
  const child = app.document.querySelector('iframe').contentWindow;
  let listeners = 0;
  child.chrome = { runtime: { onMessage: { addListener() { listeners++; } } } };
  child.eval(compile('content.ts'));
  assert.equal(listeners, 1);
});

test('embedded player needs observed visibility to start but stays pausable after scrolling away', async t => {
  const app = fixture(t, { html: '<iframe src="https://player.yuketang.cn/video"></iframe>' });
  const child = app.document.querySelector('iframe').contentWindow;
  child.document.write('<html><body><video src="https://media.example/video.mp4"></video></body></html>');
  child.document.close();
  const video = child.document.querySelector('video');
  video.getClientRects = () => [{ width: 640, height: 360 }];
  Object.defineProperty(video, 'clientWidth', { value: 640 });
  Object.defineProperty(video, 'clientHeight', { value: 360 });
  const media = app.mockVideo(video);
  let observeCallback;
  let handler;
  const observed = new Set();
  child.IntersectionObserver = class {
    constructor(callback) { observeCallback = callback; }
    observe(target) { observed.add(target); }
    unobserve(target) { observed.delete(target); }
  };
  child.chrome = { runtime: { onMessage: { addListener(listener) { handler = listener; } } } };
  child.eval(compile('content.ts'));
  function message(action) {
    let response;
    handler({ type: 'courseHelper', action, platform: 'rain' }, {}, value => { response = value; });
    return response;
  }
  assert.equal(message('getStatus').hasVideo, false);
  assert.equal(observed.has(video), true);
  message('start');
  assert.equal(media.playCalls, 0);
  observeCallback([{ target: video, isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(message('getStatus').hasVideo, true);
  assert.equal(message('start').enabled, true);
  await flush();
  assert.equal(media.playCalls, 1);
  observeCallback([{ target: video, isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(message('getStatus').hasVideo, true);
  assert.equal(message('pause').enabled, false);
  assert.equal(media.paused, true);
  assert.equal(message('getStatus').hasVideo, false);
  message('start');
  assert.equal(media.playCalls, 1);
});
