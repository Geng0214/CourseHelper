import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

async function load(entry) {
  const bundled = buildSync({ entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))], bundle: true,
    format: 'esm', platform: 'node', target: 'es2022', write: false }).outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`);
}
const api = await load('api.ts');
const { createQuizJobs } = await load('quiz-jobs.ts');
const quiz = await load('quiz.ts');
const settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'unit-secret-key', model: 'unit-model', autoFill: true, autoSubmit: true };
const question = (index = 1) => ({ id: `q${index}`, type: 'single', text: `单选题 ${index}：1 + 1 等于？`, options: [{ id: 'A', text: '2' }, { id: 'B', text: '3' }] });
const choiceAnswer = q => ({ id: q.id, optionIds: ['A'], explanation: '1 + 1 = 2。' });
const response = answers => ({ choices: [{ message: { content: JSON.stringify({ answers }) } }] });

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check, message = 'timed out') {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
const settled = jobs => until(() => jobs.get(7)?.status !== 'running' && jobs.get(7), 'quiz job did not settle');

function jobHarness(overrides = {}) {
  const calls = [];
  const defaultQuestions = [question()];
  const deps = {
    settings: async () => ({ ...settings }),
    frames: async () => [{ frameId: 0, url: 'https://www.yuketang.cn/course/quiz' }],
    solve: async (_settings, questions) => ({ answers: questions.map(choiceAnswer) }),
    send: async (_tabId, frameId, request) => {
      calls.push({ frameId, ...request });
      if (request.action === 'getQuiz') return { questions: defaultQuestions, skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: request.answers.length, skipped: 0, errors: [] };
      if (request.action === 'submitQuiz') return { submitted: true, confirmed: true, message: '页面显示提交成功。' };
      throw new Error('Unexpected request');
    },
    ...overrides,
  };
  return { jobs: createQuizJobs(deps), calls, deps };
}

test('API endpoints normalize base URLs and exact Chat Completions endpoints', () => {
  assert.equal(api.endpointFor(' https://api.example.com/ '), 'https://api.example.com/v1/chat/completions');
  assert.equal(api.endpointFor('https://api.example.com/compatible-mode/v1/'), 'https://api.example.com/compatible-mode/v1/chat/completions');
  assert.equal(api.endpointFor('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(api.endpointFor('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  for (const value of ['http://api.example.com/v1', 'https://user:password@api.example.com', 'https://api.example.com/v1?key=secret', 'javascript:alert(1)']) {
    assert.throws(() => api.endpointFor(value));
  }
});

test('local model endpoints accept no API key, while remote services still require one', () => {
  const local = api.normalizeSettings({ ...settings, baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' });
  assert.equal(local.apiKey, '');
  assert.throws(() => api.normalizeSettings({ ...settings, apiKey: '' }), /密钥/);
  assert.throws(() => api.normalizeSettings({ ...settings, apiKey: 'key\nheader' }), /密钥/);
});

test('API parses fenced JSON but rejects foreign, duplicate and invalid choice IDs', () => {
  const q = question();
  assert.equal(api.parseAnswers({ choices: [{ message: { content: '```json\n' + JSON.stringify({ answers: [choiceAnswer(q)] }) + '\n```' } }] }, [q]).answers[0].id, q.id);
  assert.throws(() => api.parseAnswers(response([{ id: 'other', optionIds: ['A'] }]), [q]), /不属于/);
  assert.throws(() => api.parseAnswers(response([choiceAnswer(q), choiceAnswer(q)]), [q]), /重复/);
  assert.throws(() => api.parseAnswers(response([{ id: q.id, optionIds: ['Z'] }]), [q]), /选项/);
  assert.throws(() => api.parseAnswers(response([{ id: q.id, optionIds: ['A', 'B'] }]), [q]), /选项/);
  assert.throws(() => api.parseAnswers({ choices: [{ message: { content: 'just click A' } }] }, [q]), /JSON/);
});

test('API allows multiple selections only for a multiple-choice question', () => {
  const q = { ...question(), type: 'multiple' };
  const result = api.parseAnswers(response([{ id: q.id, optionIds: ['A', 'B'] }]), [q]);
  assert.deepEqual(result.answers[0].optionIds, ['A', 'B']);
  assert.throws(() => api.parseAnswers(response([{ id: q.id, optionIds: ['A', 'A'] }]), [q]), /选项/);
});

test('API errors redact provider bodies and credentials for 401 and 429', async () => {
  for (const status of [401, 429]) {
    let bodyRead = false;
    await assert.rejects(api.solveQuestions(settings, [question()], {
      fetcher: async () => ({ ok: false, status, json: async () => { bodyRead = true; return { error: settings.apiKey }; } }),
    }), error => {
      assert.match(error.message, new RegExp(String(status)));
      assert(!error.message.includes(settings.apiKey));
      return true;
    });
    assert.equal(bodyRead, false);
  }
  await assert.rejects(api.solveQuestions(settings, [question()], {
    fetcher: async () => { throw new Error(`Network error: ${settings.apiKey}`); },
  }), error => !error.message.includes(settings.apiKey));
});

test('cancelling an API request aborts its fetch and exposes no raw error', async () => {
  const abort = new AbortController();
  const started = deferred();
  const task = api.solveQuestions(settings, [question()], {
    signal: abort.signal,
    fetcher: async (_url, init) => {
      started.resolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(settings.apiKey)), { once: true }));
    },
  });
  await started.promise;
  abort.abort();
  await assert.rejects(task, /已取消/);
});

test('job fills every batch before submitting the full frame snapshot', async () => {
  const questions = Array.from({ length: 6 }, (_, index) => question(index + 1));
  const calls = [];
  const batches = [];
  const app = jobHarness({
    solve: async (_settings, batch) => { batches.push(batch.length); return { answers: batch.map(choiceAnswer) }; },
    send: async (_tabId, frameId, request) => {
      calls.push({ frameId, ...request });
      if (request.action === 'getQuiz') return { questions, skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: request.answers.length, skipped: 0, errors: [] };
      return { submitted: true, confirmed: true, message: '页面显示提交成功。' };
    },
  });
  app.jobs.start(7);
  const state = await settled(app.jobs);
  assert.equal(state.status, 'done');
  assert.equal(state.completed, 6);
  assert.equal(state.results.length, 6);
  assert.deepEqual(batches, [4, 2]);
  assert.deepEqual(calls.map(call => call.action), ['getQuiz', 'applyAnswers', 'applyAnswers', 'submitQuiz']);
  assert.equal(calls.at(-1).questions.length, 6);
});

test('partial AI answers or skipped page questions prevent automatic submission', async () => {
  for (const mode of ['partial', 'skipped', 'fill-failed']) {
    const calls = [];
    const questions = [question(1), question(2)];
    const app = jobHarness({
      solve: async (_settings, batch) => ({ answers: (mode === 'partial' ? batch.slice(0, 1) : batch).map(choiceAnswer) }),
      send: async (_tabId, frameId, request) => {
        calls.push({ frameId, ...request });
        if (request.action === 'getQuiz') return { questions, skipped: mode === 'skipped' ? 1 : 0 };
        if (request.action === 'applyAnswers') return { applied: mode === 'fill-failed' ? 0 : request.answers.length, skipped: mode === 'fill-failed' ? request.answers.length : 0, errors: [] };
        throw new Error('Must not submit an incomplete page');
      },
    });
    app.jobs.start(7);
    const state = await settled(app.jobs);
    assert.equal(state.status, 'done');
    assert(!calls.some(call => call.action === 'submitQuiz'), mode);
    assert.match(state.message, /未自动提交/);
  }
});

test('a frame that failed discovery prevents automatic submission elsewhere', async () => {
  const calls = [];
  const app = jobHarness({
    frames: async () => [{ frameId: 0, url: 'https://www.yuketang.cn/course/quiz' }, { frameId: 1, url: 'https://player.yuketang.cn/quiz' }],
    send: async (_tabId, frameId, request) => {
      calls.push({ frameId, ...request });
      if (request.action === 'getQuiz' && frameId === 1) throw new Error('frame-timeout');
      if (request.action === 'getQuiz') return { questions: [question()], skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: 1, skipped: 0, errors: [] };
      return { submitted: true, confirmed: true, message: 'success' };
    },
  });
  app.jobs.start(7);
  const state = await settled(app.jobs);
  assert(!calls.some(call => call.action === 'submitQuiz'));
  assert.match(state.message, /未.*提交|停止/);
});

test('navigation while the API is answering prevents both filling and submission', async () => {
  let frameCalls = 0;
  const app = jobHarness({ frames: async () => [{ frameId: 0, url: ++frameCalls === 1 ? 'https://www.yuketang.cn/course/quiz' : 'https://www.yuketang.cn/other/quiz' }] });
  app.jobs.start(7);
  const state = await settled(app.jobs);
  assert.equal(state.status, 'error');
  assert.match(state.message, /切换|变化/);
  assert(!app.calls.some(call => ['applyAnswers', 'submitQuiz'].includes(call.action)));
});

test('only a missing receiver delegated to a known same-origin parent is safe to ignore', async () => {
  for (const mode of ['same-origin', 'cross-origin', 'unknown-parent', 'top-frame']) {
    const calls = [];
    const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course/quiz' },
      { frameId: 1, parentFrameId: mode === 'unknown-parent' ? 99 : 0,
        url: mode === 'cross-origin' ? 'https://player.yuketang.cn/quiz' : 'https://www.yuketang.cn/embedded/quiz' }];
    const app = jobHarness({ frames: async () => frames, send: async (_tab, frameId, request) => {
      calls.push({ frameId, ...request });
      if (request.action === 'getQuiz' && frameId === (mode === 'top-frame' ? 0 : 1)) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      if (request.action === 'getQuiz') return { questions: [question()], skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: 1, skipped: 0, errors: [] };
      return { submitted: true, confirmed: true, message: '提交成功' };
    } });
    app.jobs.start(7);
    const state = await settled(app.jobs);
    assert.equal(calls.some(call => call.action === 'submitQuiz'), mode === 'same-origin', mode);
    if (mode !== 'same-origin') assert.match(state.message, /未自动提交/, mode);
  }
});

test('a new embedded frame appearing after filling prevents submission', async () => {
  let frameCalls = 0;
  const initial = { frameId: 0, parentFrameId: -1, url: 'https://www.yuketang.cn/course/quiz' };
  const app = jobHarness({ frames: async () => ++frameCalls < 3 ? [initial] : [initial,
    { frameId: 2, parentFrameId: 0, url: 'https://player.yuketang.cn/new-quiz' }] });
  app.jobs.start(7);
  const state = await settled(app.jobs);
  assert.equal(state.status, 'error');
  assert.match(state.message, /嵌入题目已变化/);
  assert(app.calls.some(call => call.action === 'applyAnswers'));
  assert(!app.calls.some(call => call.action === 'submitQuiz'));
});

test('a repeated run while running reuses the same job instead of spending another API call', async () => {
  const pending = deferred();
  let solves = 0;
  const app = jobHarness({ solve: async (_settings, questions) => { solves++; await pending.promise; return { answers: questions.map(choiceAnswer) }; } });
  const first = app.jobs.start(7);
  const second = app.jobs.start(7);
  assert.equal(second.jobId, first.jobId);
  await until(() => solves === 1);
  pending.resolve();
  await settled(app.jobs);
  assert.equal(solves, 1);
});

test('cancellation during API work prevents pending answers from being filled', async () => {
  const pending = deferred();
  let entered = false;
  const app = jobHarness({ solve: async (_settings, questions) => { entered = true; await pending.promise; return { answers: questions.map(choiceAnswer) }; } });
  app.jobs.start(7);
  await until(() => entered);
  assert.equal(app.jobs.cancel(7).status, 'cancelled');
  pending.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.jobs.get(7).status, 'cancelled');
  assert(!app.calls.some(call => ['applyAnswers', 'submitQuiz'].includes(call.action)));
});

test('a delayed cancellation keeps the old job ID when a new job has already begun submitting', async () => {
  const firstSolve = deferred();
  const delayedFrames = deferred();
  const submission = deferred();
  const frame = { frameId: 0, url: 'https://www.yuketang.cn/course/quiz' };
  const calls = [];
  let frameCalls = 0;
  let solves = 0;
  const app = jobHarness({
    frames: async () => ++frameCalls === 2 ? delayedFrames.promise : [frame],
    solve: async (_settings, batch) => {
      if (++solves === 1) await firstSolve.promise;
      return { answers: batch.map(choiceAnswer) };
    },
    send: async (_tab, _frame, request) => {
      calls.push(request);
      if (request.action === 'getQuiz') return { questions: [question()], skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: 1, skipped: 0, errors: [] };
      if (request.action === 'submitQuiz') return submission.promise;
      return { cancelled: true };
    },
  });
  const first = app.jobs.start(7);
  await until(() => solves === 1);
  app.jobs.cancel(7);
  const second = app.jobs.start(7);
  assert.notEqual(first.jobId, second.jobId);
  await until(() => calls.some(call => call.action === 'submitQuiz'));
  delayedFrames.resolve([frame]);
  await until(() => calls.some(call => call.action === 'cancelQuiz'));
  assert.equal(calls.find(call => call.action === 'cancelQuiz').jobId, first.jobId);
  assert.equal(calls.find(call => call.action === 'submitQuiz').jobId, second.jobId);
  firstSolve.resolve();
  submission.resolve({ submitted: true, confirmed: true, message: '提交成功' });
  assert.equal((await settled(app.jobs)).status, 'done');
});

test('answer preview mode never sends fill or submit commands', async () => {
  const app = jobHarness({ settings: async () => ({ ...settings, autoFill: false, autoSubmit: true }) });
  app.jobs.start(7);
  const state = await settled(app.jobs);
  assert.equal(state.status, 'done');
  assert.equal(state.results.length, 1);
  assert(!app.calls.some(call => ['applyAnswers', 'submitQuiz'].includes(call.action)));
});

test('an unconfirmed submit prevents automatic submission of later independent frames', async () => {
  const calls = [];
  const app = jobHarness({
    frames: async () => [{ frameId: 0, url: 'https://www.yuketang.cn/course/quiz' }, { frameId: 1, url: 'https://player.yuketang.cn/quiz' }],
    send: async (_tabId, frameId, request) => {
      calls.push({ frameId, ...request });
      if (request.action === 'getQuiz') return { questions: [question(frameId + 1)], skipped: 0 };
      if (request.action === 'applyAnswers') return { applied: 1, skipped: 0, errors: [] };
      return { submitted: true, confirmed: false, message: '已发起提交，请以页面结果为准。' };
    },
  });
  app.jobs.start(7);
  await settled(app.jobs);
  assert.deepEqual(calls.filter(call => call.action === 'submitQuiz').map(call => call.frameId), [0]);
});

test('real localhost HTTP endpoint completes API → DOM fill → explicit submit confirmation', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    const questions = JSON.parse(body.messages.find(message => message.role === 'user').content).questions;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response(questions.map(choiceAnswer))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { port } = server.address();
  const dom = new JSDOM('<!doctype html><form><fieldset><legend>单选题：1 + 1 等于？</legend><label><input type="radio" name="q1" value="A">A. 2</label><label><input type="radio" name="q1" value="B">B. 3</label></fieldset><button type="button" id="submit">提交答案</button></form>', { url: 'https://www.yuketang.cn/course/quiz' });
  t.after(() => dom.window.close());
  dom.window.Element.prototype.getClientRects = function () { return [{ width: 600, height: 80 }]; };
  const doc = dom.window.document;
  let submissions = 0;
  doc.querySelector('#submit').addEventListener('click', () => {
    submissions++;
    const message = doc.createElement('p');
    message.className = 'submit-success';
    message.textContent = '提交成功';
    doc.body.append(message);
  });
  const jobs = createQuizJobs({
    settings: async () => ({ ...settings, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '' }),
    frames: async () => [{ frameId: 0, url: doc.URL }],
    send: async (_tabId, _frameId, request) => {
      if (request.action === 'getQuiz') return quiz.scanQuizDetailed(doc);
      if (request.action === 'applyAnswers') return quiz.applyAnswers(doc, request.answers, request.questions);
      if (request.action === 'submitQuiz') return quiz.submitQuiz(doc, request.questions);
      throw new Error('Unexpected request');
    },
  });
  jobs.start(7);
  const state = await settled(jobs);
  assert.equal(state.status, 'done', state.message);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].body.model, 'unit-model');
  assert.equal(requests[0].body.stream, false);
  assert.equal(doc.querySelector('input[value="A"]').checked, true);
  assert.equal(submissions, 1);
  assert.match(state.message, /提交成功/);
});
