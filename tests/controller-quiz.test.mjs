import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHarness } from './helpers.mjs';

test('content message cancellation reaches the quiz adapter before a delayed confirmation', async t => {
  const app = contentHarness({ html: '<form><fieldset><legend>单选题：1 + 1 等于？</legend><label><input type="radio" name="q1" value="A">A. 2</label><label><input type="radio" name="q1" value="B">B. 3</label></fieldset><button type="button" id="submit">提交答案</button></form>' });
  t.after(() => app.close());
  const { questions } = await app.message('getQuiz');
  assert.equal(questions.length, 1);
  const filled = await app.message('applyAnswers', { questions, answers: [{ id: questions[0].id, optionIds: ['A'] }] });
  assert.equal(filled.applied, 1);
  let submits = 0;
  let confirmations = 0;
  app.document.querySelector('#submit').addEventListener('click', () => {
    submits++;
    app.window.setTimeout(() => {
      const dialog = app.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<p>确定提交作业吗？</p><button type="button">确定</button>';
      dialog.querySelector('button').addEventListener('click', () => confirmations++);
      app.document.body.append(dialog);
    }, 150);
  });
  // Exercise content.ts's callback response channel, including its async `true`
  // return, rather than calling the adapter directly.
  const pending = new Promise(resolve => {
    const keptOpen = app.listeners[0]({ type: 'courseHelper', action: 'submitQuiz', questions, jobId: 'running-job' },
      { id: 'test-course-helper' }, resolve);
    assert.equal(keptOpen, true);
  });
  assert.equal(submits, 1);
  await app.clock.tick(20);
  const stopped = await app.message('cancelQuiz', { jobId: 'running-job' });
  assert.equal(stopped.cancelled, true);
  await app.clock.tick(1000);
  const result = await pending;
  assert.equal(confirmations, 0);
  assert.equal(result.submitted, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /已停止后续提交确认/);
});

test('a late cancellation from an older job cannot abort the current submission', async t => {
  const app = contentHarness({ html: '<form><fieldset><legend>单选题：1 + 1 等于？</legend><label><input type="radio" name="q1" value="A">A. 2</label><label><input type="radio" name="q1" value="B">B. 3</label></fieldset><button type="button" id="submit">提交答案</button></form>' });
  t.after(() => app.close());
  const { questions } = await app.message('getQuiz');
  await app.message('applyAnswers', { questions, answers: [{ id: questions[0].id, optionIds: ['A'] }] });
  let confirmations = 0;
  app.document.querySelector('#submit').addEventListener('click', () => {
    app.window.setTimeout(() => {
      const dialog = app.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<p>确定提交作业吗？</p><button type="button">确定</button>';
      dialog.querySelector('button').addEventListener('click', () => {
        confirmations++;
        const success = app.document.createElement('p');
        success.className = 'submit-success';
        success.textContent = '提交成功';
        app.document.body.append(success);
      });
      app.document.body.append(dialog);
    }, 150);
  });
  const pending = new Promise(resolve => app.listeners[0](
    { type: 'courseHelper', action: 'submitQuiz', questions, jobId: 'new-job' },
    { id: 'test-course-helper' }, resolve));
  await app.clock.tick(20);
  assert.equal((await app.message('cancelQuiz', { jobId: 'old-job' })).cancelled, false);
  await app.clock.tick(250);
  assert.equal(confirmations, 1);
  assert.equal((await pending).confirmed, true);
});
