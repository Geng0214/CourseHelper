import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = transformSync(readFileSync(new URL('../quiz.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code;

function fixture(t, html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew', runScripts: 'outside-only' });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () {
    return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{ width: 600, height: 80 }];
  };
  window.module = { exports: {} };
  window.eval(compiled);
  const api = window.module.exports;
  t.after(() => dom.window.close());
  return { window, doc: window.document, ...api };
}

const nativeSingle = '<fieldset><legend>单选：1 + 1 等于？</legend><label><input type="radio" name="q1" value="A">A. 2</label><label><input type="radio" name="q1" value="B">B. 3</label></fieldset>';

test('reads a native single-choice question without including option labels in its stem', t => {
  const app = fixture(t, nativeSingle);
  const [question] = app.scanQuiz(app.doc);
  assert.equal(question.type, 'single');
  assert.equal(question.text, '单选：1 + 1 等于？');
  assert.deepEqual(JSON.parse(JSON.stringify(question.options)), [{ id: 'A', text: '2' }, { id: 'B', text: '3' }]);
  assert.equal(app.scanQuiz(app.doc)[0].id, question.id);
});

test('native selection fires normal input/change events and is idempotent', t => {
  const app = fixture(t, nativeSingle);
  const questions = app.scanQuiz(app.doc);
  let changes = 0;
  app.doc.addEventListener('change', () => changes++);
  assert.equal(app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A'] }], questions).applied, 1);
  assert.equal(app.doc.querySelector('input[value=A]').checked, true);
  app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A'] }], questions);
  assert.equal(changes, 1);
});

test('multiple-choice fill removes previous unwanted choices and selects exactly the answer', t => {
  const app = fixture(t, '<fieldset><legend>多选：选偶数</legend><label><input type="checkbox" value="A" checked>2</label><label><input type="checkbox" value="B" checked>3</label><label><input type="checkbox" value="C">4</label></fieldset>');
  const questions = app.scanQuiz(app.doc);
  assert.equal(questions[0].type, 'multiple');
  const result = app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A', 'C'] }], questions);
  assert.equal(result.applied, 1);
  assert.deepEqual([...app.doc.querySelectorAll('input')].map(input => input.checked), [true, false, true]);
});

test('recognizes chaoxing chapter custom controls and true/false identifiers', t => {
  const app = fixture(t, '<div class="TiMu"><div class="Zy_TItle"><span>判断题</span><p>地球是行星。</p></div><ul class="Zy_ulTop"><li role="radio" aria-checked="false"><span class="num_option" data="true">A.</span><a class="after">正确</a></li><li role="radio" aria-checked="false"><span class="num_option" data="false">B.</span><a class="after">错误</a></li></ul></div>');
  const questions = app.scanQuiz(app.doc);
  assert.equal(questions[0].type, 'boolean');
  assert.equal(questions[0].options[0].id, 'true');
  const first = app.doc.querySelector('li');
  let clicks = 0;
  first.addEventListener('click', () => { clicks++; first.setAttribute('aria-checked', 'true'); });
  const result = app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['true'] }], questions);
  assert.equal(result.applied, 1);
  app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['true'] }], questions);
  assert.equal(clicks, 1);
});

test('recognizes chaoxing homework answerBg controls', t => {
  const app = fixture(t, '<div class="questionLi"><h3 class="mark_name"><span class="colorShallow">单选题</span>水的化学式是？</h3><div class="stem_answer"><div class="answerBg" role="radio"><span class="num_option" data="A">A</span><div class="answer_p">H2O</div></div><div class="answerBg" role="radio"><span class="num_option" data="B">B</span><div class="answer_p">CO2</div></div></div></div>');
  const [question] = app.scanQuiz(app.doc);
  assert.equal(question.type, 'single');
  assert.equal(question.options[0].text, 'H2O');
  assert(!question.text.includes('CO2'));
});

test('recognizes rain Element UI options without duplicate nested controls', t => {
  const app = fixture(t, '<div class="subject-item"><div class="item-body"><div class="problem-body">单选题：下列哪个是质数？</div><ul><li><label class="el-radio"><span role="radio"><input type="radio" name="rain" value="A"></span><span class="el-radio__label">7</span></label></li><li><label class="el-radio"><span role="radio"><input type="radio" name="rain" value="B"></span><span class="el-radio__label">9</span></label></li></ul></div></div>');
  const [question] = app.scanQuiz(app.doc);
  assert.equal(question.options.length, 2);
  assert.equal(question.options[0].text, '7');
  assert.equal(app.applyAnswers(app.doc, [{ id: question.id, optionIds: ['A'] }]).applied, 1);
});

test('does not duplicate nested question marker classes or read unrelated account inputs', t => {
  const app = fixture(t, `<form><input name="password" type="password"><input name="email"></form><div class="question-item">${nativeSingle}</div>`);
  assert.equal(app.scanQuiz(app.doc).length, 1);
});

test('skips hidden, encrypted-font, image-dependent and unrecognized question types', t => {
  const app = fixture(t, `<div hidden>${nativeSingle}</div><div style="display:none">${nativeSingle}</div><div class="TiMu"><div class="Zy_TItle font-cxsecret">乱码题干</div><textarea></textarea></div><fieldset><legend>判断图中内容 <img src="diagram.png"></legend><label><input type="radio">对</label><label><input type="radio">错</label></fieldset><div class="problem-item"><h3>排序题</h3><div>甲 乙 丙</div></div>`);
  assert.equal(app.scanQuiz(app.doc).length, 0);
  assert(app.scanQuizDetailed(app.doc).skipped >= 3);
});

test('changed question or option text rejects stale API answers', t => {
  const app = fixture(t, nativeSingle);
  const original = app.scanQuiz(app.doc);
  app.doc.querySelector('legend').textContent = '单选：2 + 2 等于？';
  const result = app.applyAnswers(app.doc, [{ id: original[0].id, optionIds: ['A'] }], original);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert(!app.doc.querySelector('input').checked);
});

test('invalid option IDs and multiple answers to single-choice questions make no mutation', t => {
  const app = fixture(t, nativeSingle);
  const [question] = app.scanQuiz(app.doc);
  assert.equal(app.applyAnswers(app.doc, [{ id: question.id, optionIds: ['Z'] }]).applied, 0);
  assert.equal(app.applyAnswers(app.doc, [{ id: question.id, optionIds: ['A', 'B'] }]).applied, 0);
  assert(!app.doc.querySelector('input').checked);
});

test('text answers use plain values and notify framework listeners', t => {
  const app = fixture(t, '<div class="questionLi"><h3 class="mark_name">简答题：给出例子</h3><textarea></textarea></div>');
  const questions = app.scanQuiz(app.doc);
  assert.equal(questions[0].type, 'text');
  let changes = 0;
  app.doc.querySelector('textarea').addEventListener('input', () => changes++);
  const result = app.applyAnswers(app.doc, [{ id: questions[0].id, text: '<script>alert(1)</script>' }], questions);
  assert.equal(result.applied, 1);
  assert.equal(app.doc.querySelector('textarea').value, '<script>alert(1)</script>');
  assert.equal(app.doc.querySelectorAll('script').length, 0);
  assert.equal(changes, 1);
});

test('multiple blanks require an exact answer count before any field changes', t => {
  const app = fixture(t, '<fieldset><legend>填空题：两种颜色</legend><input type="text"><input type="text"></fieldset>');
  const questions = app.scanQuiz(app.doc);
  assert.match(questions[0].text, /2 个答题框/);
  assert.equal(app.applyAnswers(app.doc, [{ id: questions[0].id, text: '红色' }]).applied, 0);
  assert.equal(app.doc.querySelector('input').value, '');
  assert.equal(app.applyAnswers(app.doc, [{ id: questions[0].id, text: '红色 | 蓝色' }]).applied, 1);
  assert.deepEqual([...app.doc.querySelectorAll('input')].map(input => input.value), ['红色', '蓝色']);
});

test('disabled and readonly controls are never filled', t => {
  const app = fixture(t, '<fieldset disabled><legend>单选题</legend><label><input type="radio" value="A">甲</label><label><input type="radio" value="B">乙</label></fieldset><div class="questionLi"><h3 class="mark_name">简答题</h3><textarea readonly></textarea></div>');
  assert.equal(app.scanQuiz(app.doc).length, 0);
});

test('contenteditable receives plain text without interpreting HTML', t => {
  const app = fixture(t, '<fieldset><legend>简答题：写出内容</legend><div contenteditable="true"></div></fieldset>');
  const [question] = app.scanQuiz(app.doc);
  assert.equal(app.applyAnswers(app.doc, [{ id: question.id, text: '<b>文字</b>' }]).applied, 1);
  assert.equal(app.doc.querySelector('[contenteditable]').textContent, '<b>文字</b>');
  assert.equal(app.doc.querySelector('b'), null);
});

test('answering never clicks Submit or Next', t => {
  const app = fixture(t, `${nativeSingle}<button id="submit">提交</button><button id="next">下一题</button>`);
  let submits = 0;
  for (const button of app.doc.querySelectorAll('button')) button.addEventListener('click', () => submits++);
  const questions = app.scanQuiz(app.doc);
  app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A'] }], questions);
  assert.equal(submits, 0);
});

test('question-prefixed fragments cannot hide the enclosing question', t => {
  const app = fixture(t, '<div id="question123"><div id="questionTitle123" class="Zy_TItle">单选题：选出甲</div><ul class="Zy_ulTop"><li role="radio"><span class="num_option" data="A">A.</span><a class="after">甲</a></li><li role="radio"><span class="num_option" data="B">B.</span><a class="after">乙</a></li></ul></div>');
  assert.equal(app.scanQuiz(app.doc).length, 1);
});

test('partly disabled questions are skipped rather than sending an incomplete option list', t => {
  const app = fixture(t, '<fieldset><legend>单选题：选出甲</legend><label><input type="radio" value="A" disabled>甲</label><label><input type="radio" value="B">乙</label><label><input type="radio" value="C">丙</label></fieldset>');
  assert.equal(app.scanQuiz(app.doc).length, 0);
});

function completedQuiz(t, extra = '<button type="button" id="submit">提交答案</button>') {
  const app = fixture(t, `<form>${nativeSingle}${extra}</form>`);
  const questions = app.scanQuiz(app.doc);
  app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A'] }], questions);
  return { ...app, questions };
}

test('submit requires complete current question coverage and every answer filled', async t => {
  const app = fixture(t, `<form>${nativeSingle}<button id="submit" type="button">提交</button></form>`);
  let clicks = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => clicks++);
  const questions = app.scanQuiz(app.doc);
  assert.equal((await app.submitQuiz(app.doc, [])).submitted, false);
  assert.equal((await app.submitQuiz(app.doc, questions)).submitted, false);
  assert.equal(clicks, 0);
});

test('submit refuses changed question snapshots', async t => {
  const app = completedQuiz(t);
  let clicks = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => clicks++);
  app.doc.querySelector('legend').textContent = '单选：新问题';
  assert.equal((await app.submitQuiz(app.doc, app.questions)).submitted, false);
  assert.equal(clicks, 0);
});

test('submit refuses multiple matching controls and does not use next-question buttons', async t => {
  const ambiguous = completedQuiz(t, '<button type="button">提交</button><button type="button">交卷</button>');
  let clicks = 0;
  ambiguous.doc.querySelectorAll('button').forEach(button => button.addEventListener('click', () => clicks++));
  assert.equal((await ambiguous.submitQuiz(ambiguous.doc, ambiguous.questions)).submitted, false);
  assert.equal(clicks, 0);
  const nextOnly = completedQuiz(t, '<button type="button">下一题</button>');
  assert.equal((await nextOnly.submitQuiz(nextOnly.doc, nextOnly.questions)).submitted, false);
});

test('submit dispatches the unique control and reports explicit newly rendered success', async t => {
  const app = completedQuiz(t);
  let clicks = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => {
    clicks++;
    const message = app.doc.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = '作业提交成功';
    app.doc.body.append(message);
  });
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(clicks, 1);
  assert.equal(result.submitted, true);
  assert.equal(result.confirmed, true);
});

test('submit confirms one explicit submission dialog', async t => {
  const app = completedQuiz(t);
  let confirms = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => {
    const dialog = app.doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<p>确定提交本次作业吗？</p><button type="button">取消</button><button type="button" id="confirm">确定</button>';
    app.doc.body.append(dialog);
    dialog.querySelector('#confirm').addEventListener('click', () => {
      confirms++;
      dialog.remove();
      const message = app.doc.createElement('p');
      message.className = 'submit-success';
      message.textContent = '提交成功';
      app.doc.body.append(message);
    });
  });
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(confirms, 1);
  assert.equal(result.confirmed, true);
});

test('submit stops when a confirmation dialog has ambiguous controls', async t => {
  const app = completedQuiz(t);
  let confirms = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => {
    const dialog = app.doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<p>确认提交？</p><button type="button">确定</button><button type="button">确认提交</button>';
    dialog.querySelectorAll('button').forEach(button => button.addEventListener('click', () => confirms++));
    app.doc.body.append(dialog);
  });
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(confirms, 0);
  assert.equal(result.submitted, false);
  assert.match(result.message, /确认框不明确/);
});

test('submit never treats a previous success toast as proof this submission succeeded', async t => {
  const app = completedQuiz(t);
  const toast = app.doc.createElement('p');
  toast.className = 'submit-success';
  toast.textContent = '提交成功';
  app.doc.body.append(toast);
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(result.submitted, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /已发起提交/);
});

test('submit recognizes a new platform rejection without claiming acceptance', async t => {
  const app = completedQuiz(t);
  app.doc.querySelector('#submit').addEventListener('click', () => {
    const error = app.doc.createElement('p');
    error.setAttribute('role', 'alert');
    error.textContent = '提交失败，请稍后重试';
    app.doc.body.append(error);
  });
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(result.submitted, false);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /未接受提交/);
});

test('submit refuses partially recognized pages and multiple forms', async t => {
  const partial = completedQuiz(t);
  const unknown = partial.doc.createElement('div');
  unknown.className = 'question-item';
  unknown.innerHTML = '<h3>排序题</h3><p>甲 乙 丙</p>';
  partial.doc.body.append(unknown);
  assert.equal((await partial.submitQuiz(partial.doc, partial.questions)).submitted, false);
  const multiple = fixture(t, `<form>${nativeSingle}<button type="button">提交</button></form><form><fieldset><legend>简答题</legend><textarea></textarea></fieldset><button type="button">提交</button></form>`);
  const questions = multiple.scanQuiz(multiple.doc);
  multiple.applyAnswers(multiple.doc, [{ id: questions[0].id, optionIds: ['A'] }, { id: questions[1].id, text: '例子' }], questions);
  const result = await multiple.submitQuiz(multiple.doc, questions);
  assert.equal(result.submitted, false);
  assert.match(result.message, /多个表单/);
});

test('prevented selection is not reported as a successfully filled answer', t => {
  const app = fixture(t, nativeSingle);
  const questions = app.scanQuiz(app.doc);
  app.doc.querySelector('input[value=A]').addEventListener('click', event => event.preventDefault());
  const result = app.applyAnswers(app.doc, [{ id: questions[0].id, optionIds: ['A'] }], questions);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(app.doc.querySelector('input[value=A]').checked, false);
});

test('submission stops if an answer reverts or is changed after filling', async t => {
  const app = completedQuiz(t);
  let submits = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => submits++);
  app.doc.querySelector('input[value=B]').click();
  const result = await app.submitQuiz(app.doc, app.questions);
  assert.equal(result.submitted, false);
  assert.match(result.message, /答案状态已变化/);
  assert.equal(submits, 0);
});

test('hidden questions, active quiz pagination and unanswered answer cards prevent whole-paper submission', async t => {
  for (const extra of [
    '<div hidden><fieldset><legend>单选题：隐藏的第二题</legend><label><input type="radio" value="A">甲</label><label><input type="radio" value="B">乙</label></fieldset></div>',
    '<nav class="question-pagination"><button type="button">下一页</button></nav>',
    '<div class="answer-card"><span class="unanswered">2 未答</span></div>',
    '<div class="exam-info">共 10 题</div>',
  ]) {
    const app = completedQuiz(t, '<button type="button" id="submit">提交答案</button>' + extra);
    let submits = 0;
    app.doc.querySelector('#submit').addEventListener('click', () => submits++);
    const result = await app.submitQuiz(app.doc, app.questions);
    assert.equal(result.submitted, false, extra);
    assert.equal(submits, 0, extra);
  }
});

test('unrelated page navigation and empty hidden templates do not block a complete form', async t => {
  const app = completedQuiz(t, '<button type="button" id="submit">提交答案</button><div hidden class="question-item"><h3></h3></div>');
  const other = app.doc.createElement('nav');
  other.innerHTML = '<button type="button">下一页</button>';
  app.doc.body.append(other);
  app.doc.querySelector('#submit').addEventListener('click', () => {
    const success = app.doc.createElement('p');
    success.className = 'submit-success';
    success.textContent = '提交成功';
    app.doc.body.append(success);
  });
  assert.equal((await app.submitQuiz(app.doc, app.questions)).confirmed, true);
});

test('cancellation before a delayed submission dialog prevents its late confirmation', async t => {
  const app = completedQuiz(t);
  const abort = new AbortController();
  let submits = 0;
  let confirmations = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => {
    submits++;
    setTimeout(() => {
      const dialog = app.doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<p>确定提交作业吗？</p><button type="button">确定</button>';
      dialog.querySelector('button').addEventListener('click', () => confirmations++);
      app.doc.body.append(dialog);
    }, 30);
  });
  const task = app.submitQuiz(app.doc, app.questions, abort.signal);
  setTimeout(() => abort.abort(), 10);
  const result = await task;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(submits, 1);
  assert.equal(confirmations, 0);
  assert.equal(result.submitted, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /已停止后续提交确认/);
});

test('an already cancelled submission never clicks its main submit button', async t => {
  const app = completedQuiz(t);
  const abort = new AbortController();
  abort.abort();
  let clicks = 0;
  app.doc.querySelector('#submit').addEventListener('click', () => clicks++);
  assert.equal((await app.submitQuiz(app.doc, app.questions, abort.signal)).submitted, false);
  assert.equal(clicks, 0);
});
