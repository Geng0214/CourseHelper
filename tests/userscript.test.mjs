import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = buildSync({ entryPoints: ['userscript.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const { createFrameChannel, makeGmFetcher, createUserscriptRunner, startUserscript, describeFrame } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);

function storageNetwork() {
  const values = new Map();
  const subscriptions = new Map();
  let next = 0;
  return {
    values,
    client(name) {
      return {
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        set(key, value) {
          const before = values.get(key);
          values.set(key, value);
          for (const subscription of subscriptions.values()) {
            if (subscription.key === key) queueMicrotask(() => subscription.listener(key, before, value, subscription.client !== name));
          }
        },
        remove(key) {
          const before = values.get(key);
          values.delete(key);
          for (const subscription of subscriptions.values()) {
            if (subscription.key === key) queueMicrotask(() => subscription.listener(key, before, undefined, subscription.client !== name));
          }
        },
        listen(key, listener) { const id = ++next; subscriptions.set(id, { key, listener, client: name }); return id; },
        unlisten(id) { subscriptions.delete(id); },
        keys: () => [...values.keys()],
      };
    },
  };
}
const status = (extra = {}) => ({ platform: 'rain', enabled: false, autoNext: false, message: 'ready', hasVideo: false, videoArea: 0, playbackRate: 1, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const question = { id: 'd0:q1', type: 'single', text: '1 + 1 = ?', options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] };
const settings = { baseUrl: 'https://api.example.test/v1', apiKey: 'example-test-key', model: 'test-model', autoFill: true, autoSubmit: true };

test('userscript startup mounts its panel even when GM_saveTab never calls a callback', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.yuketang.cn/v2/web/index', pretendToBeVisual: true });
  const network = storageNetwork();
  const storage = network.client('start');
  const tab = {};
  const globals = {
    window: dom.window, document: dom.window.document, location: dom.window.location, sessionStorage: dom.window.sessionStorage,
    GM_getValue: storage.get, GM_setValue: storage.set, GM_deleteValue: storage.remove, GM_listValues: storage.keys,
    GM_addValueChangeListener: storage.listen, GM_removeValueChangeListener: storage.unlisten,
    GM_getTab: callback => callback(tab), GM_saveTab: value => Object.assign(tab, value),
    GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => { throw new Error('No real network in startup test'); },
  };
  const before = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await startUserscript();
  assert(dom.window.document.getElementById('course-helper-panel'));
  assert.equal(tab.courseHelperSession.platform, 'rain');
});

test('userscript bus routes only fixed commands within the same tab and page', async t => {
  const network = storageNetwork();
  const calls = [];
  const session = { tab: 'tab-one', page: 'page-one', platform: 'rain' };
  const main = createFrameChannel(network.client('main'), session, 'main', { handle: () => status() });
  const player = createFrameChannel(network.client('player'), session, 'player', { handle(request) {
    calls.push(request);
    return status({ hasVideo: true, videoArea: 1000, enabled: request.action === 'start' });
  } });
  const foreign = createFrameChannel(network.client('foreign'), { ...session, tab: 'tab-two' }, 'foreign', { handle: () => status({ hasVideo: true, videoArea: 99999 }) });
  t.after(() => { main.close(); player.close(); foreign.close(); });
  await flush();
  assert.deepEqual(main.frames().map(peer => peer.frame), ['player', 'main']);
  const result = await main.call('player', 'start', { type: 'injected', platform: 'chaoxing' });
  assert.equal(result.enabled, true);
  assert.deepEqual(calls.find(call => call.action === 'start'), { type: 'courseHelper', platform: 'rain', action: 'start' });
  await assert.rejects(main.call('player', 'eval', { code: 'anything' }), /不支持/);
  assert(!network.values.has('courseHelper.bus.tab-one.request'));
  assert(!network.values.has('courseHelper.bus.tab-one.response'));
});

test('userscript bus awaits asynchronous form submission', async t => {
  const network = storageNetwork();
  const session = { tab: 't', page: 'p', platform: 'rain' };
  const main = createFrameChannel(network.client('main'), session, 'main', { handle: () => status() });
  const child = createFrameChannel(network.client('child'), session, 'child', { handle: request => request.action === 'submitQuiz'
    ? Promise.resolve({ submitted: true, confirmed: true, message: 'done' }) : status() });
  t.after(() => { main.close(); child.close(); });
  const result = await main.call('child', 'submitQuiz', { questions: [question] });
  assert.equal(result.submitted, true);
});

test('userscript bus does not accept another document session announcements', async t => {
  const network = storageNetwork();
  const main = createFrameChannel(network.client('main'), { tab: 't', page: 'new', platform: 'rain' }, 'main', { handle: () => status() });
  const old = createFrameChannel(network.client('old'), { tab: 't', page: 'old', platform: 'rain' }, 'old', { handle: () => status({ enabled: true, hasVideo: true }) });
  t.after(() => { main.close(); old.close(); });
  await flush();
  assert.deepEqual(main.frames().map(peer => peer.frame), ['main']);
});

test('discovery finds an earlier child and never drops a stale known frame from scans', async t => {
  const network = storageNetwork();
  const session = { tab: 'discover', page: 'p', platform: 'rain' };
  const childCoverage = { origin: 'https://child.yuketang.cn', requiredOrigins: [] };
  const child = createFrameChannel(network.client('child'), session, 'child', { handle: () => status() }, () => childCoverage);
  const main = createFrameChannel(network.client('main'), session, 'main', { handle: () => status() }, () => ({ origin: 'https://www.yuketang.cn', requiredOrigins: [childCoverage.origin] }));
  t.after(() => { main.close(); child.close(); });
  assert.equal(main.completeCoverage(), false);
  assert.deepEqual((await main.discover(undefined, 1)).map(peer => peer.frame).sort(), ['child', 'main']);
  assert.equal(main.completeCoverage(), true);
  network.client('child').set('courseHelper.bus.discover.announce', { frame: 'child', status: status(), page: 'p', at: Date.now() - 20000, coverage: childCoverage });
  await flush();
  assert(!main.frames().some(peer => peer.frame === 'child'));
  assert(main.knownFrames().some(peer => peer.frame === 'child'));
  const abort = new AbortController();
  const discovering = main.discover(abort.signal);
  abort.abort();
  await assert.rejects(discovering, { name: 'AbortError' });
});

test('coverage requires visible course frames but ignores unrelated advertisements', () => {
  const dom = new JSDOM('<iframe src="https://child.yuketang.cn/quiz?private=id"></iframe><iframe src="https://ads.example.test/"></iframe><iframe hidden src="https://hidden.yuketang.cn/"></iframe>', { url: 'https://www.yuketang.cn/course' });
  for (const frame of dom.window.document.querySelectorAll('iframe')) frame.getClientRects = () => [({ width: 100, height: 100 })];
  assert.deepEqual(describeFrame(dom.window.document, 'rain'), { origin: 'https://www.yuketang.cn', requiredOrigins: ['https://child.yuketang.cn'] });
  dom.window.close();
});

test('userscript bus serializes overlapping commands without overwriting question payloads', async t => {
  const network = storageNetwork();
  const session = { tab: 'serial', page: 'p', platform: 'rain' };
  let finishScan;
  const received = [];
  const main = createFrameChannel(network.client('main'), session, 'main', { handle: () => status() });
  const child = createFrameChannel(network.client('child'), session, 'child', { handle(request) {
    if (request.action === 'getQuiz') { received.push('scan'); return new Promise(resolve => { finishScan = resolve; }); }
    if (request.action === 'applyAnswers') { received.push('fill'); return { applied: 1 }; }
    return status();
  } });
  t.after(() => { main.close(); child.close(); });
  const scanning = main.call('child', 'getQuiz');
  const filling = main.call('child', 'applyAnswers', { answers: [{ id: 'q', text: 'answer' }] });
  await flush();
  assert.deepEqual(received, ['scan']);
  finishScan({ questions: [question] });
  assert.deepEqual((await scanning).questions, [question]);
  assert.equal((await filling).applied, 1);
  assert.deepEqual(received, ['scan', 'fill']);
  assert(!network.values.has('courseHelper.bus.serial.request'));
  assert(!network.values.has('courseHelper.bus.serial.response'));
});

test('priority cancellation interrupts submission and cancels a queued fill', async t => {
  const network = storageNetwork();
  const session = { tab: 'cancel', page: 'p', platform: 'rain' };
  let finishSubmit;
  let fillCalls = 0;
  const main = createFrameChannel(network.client('main'), session, 'main', { handle: () => status() });
  const child = createFrameChannel(network.client('child'), session, 'child', { handle(request) {
    if (request.action === 'submitQuiz') return new Promise(resolve => { finishSubmit = resolve; });
    if (request.action === 'cancelQuiz') { finishSubmit?.({ submitted: false, confirmed: false, message: 'cancelled' }); return { cancelled: true }; }
    if (request.action === 'applyAnswers') { fillCalls++; return { applied: 1 }; }
    return status();
  } });
  t.after(() => { main.close(); child.close(); });
  const submitting = main.call('child', 'submitQuiz');
  const abort = new AbortController();
  const filling = main.call('child', 'applyAnswers', {}, abort.signal);
  const rejectedFill = assert.rejects(filling, { name: 'AbortError' });
  await flush();
  abort.abort();
  await main.call('*', 'cancelQuiz');
  assert.equal((await submitting).confirmed, false);
  await rejectedFill;
  assert.equal(fillCalls, 0);
});

test('opening a script page removes expired private bus data left by a crash', t => {
  const network = storageNetwork();
  const storage = network.client('main');
  storage.set('courseHelper.bus.closed.response', { expiresAt: 1, result: { questions: ['private old text'] } });
  storage.set('courseHelper.apiSettings.v1', { apiKey: 'keep-my-settings' });
  const channel = createFrameChannel(storage, { tab: 'fresh', page: 'p', platform: 'rain' }, 'main', { handle: () => status() });
  t.after(() => channel.close());
  assert(!network.values.has('courseHelper.bus.closed.response'));
  assert(network.values.has('courseHelper.apiSettings.v1'));
});

test('GM API adapter sends no cookies and rejects redirects', async () => {
  let outbound;
  const fetcher = makeGmFetcher(request => {
    outbound = request;
    queueMicrotask(() => request.onload({ status: 200, responseText: '{"ok":true}', finalUrl: request.url }));
    return { abort() {} };
  });
  const response = await fetcher('https://api.example.test/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: '{}' });
  assert.equal(outbound.anonymous, true);
  assert.equal(outbound.redirect, 'error');
  assert.equal(outbound.headers.authorization, 'Bearer test');
  assert.deepEqual(await response.json(), { ok: true });
});

test('GM API adapter aborts its request when the job is cancelled', async () => {
  let aborts = 0;
  const fetcher = makeGmFetcher(() => ({ abort() { aborts++; } }));
  const controller = new AbortController();
  const promise = fetcher('https://api.example.test/v1/chat/completions', { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(aborts, 1);
});

test('GM API adapter rejects malformed and cross-domain responses', async () => {
  const failed = makeGmFetcher(request => {
    queueMicrotask(() => request.onload({ status: 0, responseText: '' }));
    return { abort() {} };
  });
  await assert.rejects(failed('https://api.example.test/v1'), /HTTP/);
  const redirected = makeGmFetcher(request => {
    queueMicrotask(() => request.onload({ status: 200, responseText: '{}', finalUrl: 'https://other.example.test/' }));
    return { abort() {} };
  });
  await assert.rejects(redirected('https://api.example.test/v1'), /其他域名/);
});

function runnerFixture({ config = settings, questions = [question], skipped = 0, applied, answers, fetcher, submission, malformedPeer = false, coverage = true, newFrame = false } = {}) {
  const calls = [];
  let added = false;
  const channel = {
    frames: () => [{ frame: 'frame1', at: Date.now(), status: status() }, ...(malformedPeer || added ? [{ frame: 'frame2', at: Date.now(), status: status() }] : [])],
    knownFrames() { return this.frames(); },
    async discover() { return this.frames(); },
    completeCoverage: () => coverage,
    async call(frame, action, payload = {}) {
      calls.push({ frame, action, payload });
      if (action === 'getQuiz') return frame === 'frame2' ? {} : { questions, skipped };
      if (action === 'applyAnswers') { added = newFrame; return { applied: applied ?? payload.answers.length, skipped: 0, errors: [] }; }
      if (action === 'submitQuiz') return submission || { submitted: true, confirmed: true, message: 'submitted' };
    },
  };
  const defaultFetcher = async (_url, init) => {
    const sent = JSON.parse(JSON.parse(init.body).messages[1].content).questions;
    const values = answers ? answers(sent) : sent.map(q => ({ id: q.id, optionIds: ['a'], explanation: 'basic arithmetic' }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: values }) } }] }), { status: 200 });
  };
  return { runner: createUserscriptRunner(channel, () => config, fetcher || defaultFetcher), calls };
}
async function completed(runner) {
  for (let count = 0; count < 100; count++) {
    if (runner.status().status !== 'running') return runner.status();
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('runner did not finish');
}

test('userscript AI job fills answer snapshots then submits only after full success', async () => {
  const { runner, calls } = runnerFixture();
  assert.equal((await runner.run()).status, 'running');
  const done = await completed(runner);
  assert.equal(done.status, 'done');
  assert.deepEqual(calls.map(call => call.action), ['getQuiz', 'applyAnswers', 'submitQuiz']);
  const fill = calls.find(call => call.action === 'applyAnswers');
  assert.equal(fill.payload.answers[0].id, question.id);
  assert.deepEqual(fill.payload.questions, [question]);
  assert.match(done.message, /完成 1 处提交/);
});

test('userscript AI job never auto-submits a page containing skipped questions', async () => {
  const { runner, calls } = runnerFixture({ skipped: 1 });
  await runner.run();
  const done = await completed(runner);
  assert(!calls.some(call => call.action === 'submitQuiz'));
  assert.match(done.message, /停止自动提交/);
});

test('userscript AI job does not treat a dispatched submit as confirmed success', async () => {
  const { runner } = runnerFixture({ submission: { submitted: true, confirmed: false, message: '已发起提交，请以页面结果为准。' } });
  await runner.run();
  const done = await completed(runner);
  assert.match(done.message, /以页面结果为准/);
  assert.doesNotMatch(done.message, /完成 1 处提交/);
});

test('userscript AI job will not submit when another frame returned an invalid scan', async () => {
  const { runner, calls } = runnerFixture({ malformedPeer: true });
  await runner.run();
  const done = await completed(runner);
  assert(!calls.some(call => call.action === 'submitQuiz'));
  assert.match(done.message, /停止自动提交/);
});

test('userscript auto-submit stops for unconnected course frames or a changing frame set', async () => {
  for (const options of [{ coverage: false }, { newFrame: true }]) {
    const { runner, calls } = runnerFixture(options);
    await runner.run();
    const done = await completed(runner);
    assert(!calls.some(call => call.action === 'submitQuiz'));
    assert.match(done.message, /框架未全部连接或页面已变化/);
  }
});

test('cancelling while a local submit resolves preserves the cancelled job state', async () => {
  let finishSubmit;
  const { runner, calls } = runnerFixture({ submission: new Promise(resolve => { finishSubmit = resolve; }) });
  await runner.run();
  for (let count = 0; count < 50 && !calls.some(call => call.action === 'submitQuiz'); count++) await new Promise(resolve => setImmediate(resolve));
  assert(calls.some(call => call.action === 'submitQuiz'));
  runner.cancel();
  finishSubmit({ submitted: true, confirmed: false, message: 'cancelled' });
  await flush();
  assert.equal(runner.status().status, 'cancelled');
});

test('userscript AI job never submits incomplete model answers or failed fills', async () => {
  const two = [question, { ...question, id: 'd0:q2' }];
  const partial = runnerFixture({ questions: two, answers: sent => [{ id: sent[0].id, optionIds: ['a'] }] });
  await partial.runner.run();
  await completed(partial.runner);
  assert(!partial.calls.some(call => call.action === 'submitQuiz'));
  const failed = runnerFixture({ applied: 0 });
  await failed.runner.run();
  await completed(failed.runner);
  assert(!failed.calls.some(call => call.action === 'submitQuiz'));
});

test('userscript answer-only mode performs no page mutation', async () => {
  const { runner, calls } = runnerFixture({ config: { ...settings, autoFill: false } });
  await runner.run();
  assert.equal((await completed(runner)).results.length, 1);
  assert.deepEqual(calls.map(call => call.action), ['getQuiz']);
});

test('userscript cancellation aborts the API and prevents late answers from filling', async () => {
  let capturedSignal;
  let resolveRequest;
  const { runner, calls } = runnerFixture({ fetcher: async (_url, init) => {
    capturedSignal = init.signal;
    return await new Promise(resolve => { resolveRequest = resolve; });
  } });
  await runner.run();
  await flush();
  runner.cancel();
  assert.equal(capturedSignal.aborted, true);
  resolveRequest(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: [{ id: 'frame1::d0:q1', optionIds: ['a'] }] }) } }] }), { status: 200 }));
  await flush();
  assert.equal(runner.status().status, 'cancelled');
  assert(!calls.some(call => call.action === 'applyAnswers'));
});
