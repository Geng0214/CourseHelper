import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function compile(name) {
  return buildSync({ entryPoints: [fileURLToPath(new URL(`../${name}`, import.meta.url))],
    bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
  }).outputFiles[0].text;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

export function fakeClock(target) {
  let now = 10_000;
  let nextId = 0;
  const timers = new Map();
  target.Date.now = () => now;
  target.setTimeout = (fn, delay = 0, ...args) => {
    const id = ++nextId;
    timers.set(id, { at: now + Math.max(0, Number(delay)), fn: () => fn(...args), every: 0 });
    return id;
  };
  target.setInterval = (fn, delay = 0, ...args) => {
    const id = ++nextId;
    const every = Math.max(1, Number(delay));
    timers.set(id, { at: now + every, fn: () => fn(...args), every });
    return id;
  };
  target.clearTimeout = target.clearInterval = id => timers.delete(id);
  return {
    async tick(milliseconds) {
      const end = now + milliseconds;
      for (let count = 0; count < 10000; count++) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

export function contentHarness({
  url = 'https://www.yuketang.cn/v2/web/studentLog/123/video/1',
  html = '<video src="https://media.example/video.mp4"></video>',
  storage,
  runtimeMessage,
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const clock = fakeClock(window);
  const listeners = [];
  const outgoing = [];
  window.chrome = {
    runtime: {
      id: 'test-course-helper',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        outgoing.push(message);
        return runtimeMessage?.(message);
      },
      lastError: undefined,
    },
  };
  // JSDOM has no layout engine. Model only the visibility facts these tests need.
  window.Element.prototype.getClientRects = function () {
    if (this.closest('[hidden], [aria-hidden="true"]')) return [];
    let current = this;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      current = current.parentElement;
    }
    return [{ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 }];
  };
  window.Element.prototype.getBoundingClientRect = function () {
    return this.getClientRects()[0] || { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return this.getClientRects().length ? 640 : 0; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return this.getClientRects().length ? 360 : 0; } });
  const media = new Map();
  function mockVideo(video = window.document.querySelector('video')) {
    const state = { paused: true, ended: false, duration: 120, playCalls: 0, pauseCalls: 0, playResult: undefined };
    for (const key of ['paused', 'ended', 'duration']) {
      Object.defineProperty(video, key, { configurable: true, get: () => state[key] });
    }
    video.play = () => {
      state.playCalls++;
      state.paused = false;
      video.dispatchEvent(new window.Event('play'));
      return typeof state.playResult === 'function' ? state.playResult() : state.playResult || Promise.resolve();
    };
    video.pause = () => {
      state.pauseCalls++;
      state.paused = true;
      video.dispatchEvent(new window.Event('pause'));
    };
    state.finish = () => {
      state.ended = true;
      state.paused = true;
      video.dispatchEvent(new window.Event('ended'));
    };
    media.set(video, state);
    return state;
  }
  for (const video of window.document.querySelectorAll('video')) mockVideo(video);
  if (storage) for (const [key, value] of Object.entries(storage)) window.sessionStorage.setItem(key, value);
  window.eval(compile('content.ts'));
  async function message(action, extra = {}) {
    const request = {
      type: 'courseHelper', action,
      platform: new URL(window.location.href).hostname.endsWith('chaoxing.com') ? 'chaoxing' : 'rain',
      ...extra,
    };
    let result;
    for (const listener of listeners) {
      const returned = listener(request, { id: 'test-course-helper' }, response => { result = response; });
      if (returned && typeof returned.then === 'function') result = await returned;
    }
    await flush();
    return result;
  }
  return { dom, window, document: window.document, clock, listeners, outgoing, media, mockVideo, message,
    close() { dom.window.close(); } };
}
