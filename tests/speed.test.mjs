import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHarness } from './helpers.mjs';

test('playback speed applies to the current player and survives pause/resume', async t => {
  const app = contentHarness(); t.after(() => app.close());
  const video = app.document.querySelector('video');
  await app.message('setPlaybackRate', { playbackRate: 2 });
  assert.equal(video.playbackRate, 2);
  await app.message('start'); await app.message('pause'); await app.message('start');
  assert.equal((await app.message('getStatus')).playbackRate, 2);
});

test('speed preference survives reload without starting playback', async t => {
  const app = contentHarness(); t.after(() => app.close());
  await app.message('setPlaybackRate', { playbackRate: 3 });
  const saved = app.window.sessionStorage.getItem('courseHelperRainState');
  const next = contentHarness({ storage: { courseHelperRainState: saved } }); t.after(() => next.close());
  const status = await next.message('getStatus');
  assert.equal(status.playbackRate, 3); assert.equal(status.enabled, false);
  assert.equal([...next.media.values()][0].playCalls, 0);
});

test('invalid playback rates never mutate the player', async t => {
  const app = contentHarness(); t.after(() => app.close());
  for (const playbackRate of [NaN, Infinity, -1, 0, 99, '2']) {
    await app.message('setPlaybackRate', { playbackRate });
    assert.equal(app.document.querySelector('video').playbackRate, 1);
  }
});

test('a replacement player in the same course inherits requested speed', async t => {
  const app = contentHarness(); t.after(() => app.close());
  await app.message('setPlaybackRate', { playbackRate: 1.5 }); await app.message('start');
  app.document.querySelector('video').remove();
  const video = app.document.createElement('video'); video.src = 'https://media.example/next.mp4';
  app.document.body.prepend(video); const media = app.mockVideo(video);
  await app.clock.tick(1000);
  assert.equal(media.playCalls, 1); assert.equal(video.playbackRate, 1.5);
});

test('status shows platform-enforced speed instead of repeatedly fighting the page', async t => {
  const app = contentHarness(); t.after(() => app.close());
  await app.message('setPlaybackRate', { playbackRate: 4 }); await app.message('start');
  app.document.querySelector('video').playbackRate = 1;
  await app.clock.tick(2000);
  assert.equal((await app.message('getStatus')).playbackRate, 1);
});
