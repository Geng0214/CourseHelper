import { normalizeSettings, solveQuestions, type ApiSettings } from './api';
import type { QuizQuestion } from './quiz';

export type QuizJobState = {
  jobId: string; status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'; message: string;
  completed: number; total: number; results: Array<{ id: string; answer: string; explanation: string }>;
};
type FrameQuiz = { frameId: number; url: string; questions: QuizQuestion[]; skipped: number };
type Frame = { frameId: number; url: string; parentFrameId?: number };
export type JobDependencies = {
  settings(): Promise<ApiSettings>;
  frames(tabId: number): Promise<Frame[]>;
  send(tabId: number, frameId: number, request: Record<string, unknown>): Promise<unknown>;
  solve?: typeof solveQuestions;
  save?(tabId: number, state: QuizJobState): Promise<void>;
};

export function createQuizJobs(deps: JobDependencies) {
  const jobs = new Map<number, { state: QuizJobState; abort: AbortController }>();
  let sequence = 0;
  const idle: QuizJobState = { jobId: '', status: 'idle', message: '打开题目页，点击 AI 做本页题。', completed: 0, total: 0, results: [] };
  function publish(tabId: number) {
    const state = jobs.get(tabId)?.state;
    if (state && deps.save) void deps.save(tabId, structuredClone(state)).catch(() => undefined);
  }
  function cancelled(abort: AbortController) { if (abort.signal.aborted) throw new Error('已停止后续做题；已经填写或提交的内容不会回滚。'); }
  function delegatedToParent(frame: Frame, frames: Frame[]) {
    const parent = frames.find(candidate => candidate.frameId === frame.parentFrameId && candidate.frameId !== frame.frameId);
    if (!parent) return false;
    try { return new URL(parent.url).origin === new URL(frame.url).origin; }
    catch { return false; }
  }
  function sameFrameSet(expected: Frame[], current: Frame[]) {
    return expected.length === current.length && expected.every(frame => current.some(candidate =>
      candidate.frameId === frame.frameId && candidate.url === frame.url && candidate.parentFrameId === frame.parentFrameId));
  }
  async function driver(tabId: number, job: { state: QuizJobState; abort: AbortController }) {
    const { state, abort } = job;
    try {
      const settings = normalizeSettings(await deps.settings());
      cancelled(abort);
      const frames = await deps.frames(tabId);
      let uncertainFrame = false;
      const scans = await Promise.all(frames.map(async frame => {
        try {
          const response = await deps.send(tabId, frame.frameId, { action: 'getQuiz' }) as { questions?: QuizQuestion[]; skipped?: number };
          if (!response || !Array.isArray(response.questions)) { uncertainFrame = true; return null; }
          return {
            ...frame, questions: response.questions, skipped: Number.isInteger(response.skipped) ? Math.max(0, response.skipped!) : 0,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Only a known same-origin parent can own a child without its own
          // content listener. A missing cross-origin controller is incomplete discovery.
          if (!/Receiving end does not exist|No matching message handler/i.test(message)
            || !delegatedToParent(frame, frames)) uncertainFrame = true;
          return null;
        }
      }));
      cancelled(abort);
      const all = scans.filter((scan): scan is FrameQuiz => scan !== null);
      const usable = all.filter(scan => scan.questions.length);
      state.total = usable.reduce((sum, scan) => sum + scan.questions.length, 0);
      const unsupported = all.reduce((sum, scan) => sum + scan.skipped, 0);
      if (!state.total) throw new Error(unsupported ? '发现题目但暂不支持其结构或图片内容，请手动作答。' : '本页未识别到可作答的题目，请打开具体题目页。');
      if (state.total > 100) throw new Error('本页超过 100 道题，请按章节或分页分别做题。');
      let filled = 0;
      let generated = 0;
      const warnings: string[] = [];
      for (const frame of usable) {
        for (let offset = 0; offset < frame.questions.length; offset += 4) {
          cancelled(abort);
          const batch = frame.questions.slice(offset, offset + 4);
          state.message = `正在分析第 ${state.completed + 1}–${state.completed + batch.length} 题，共 ${state.total} 题…`;
          publish(tabId);
          const { answers } = await (deps.solve || solveQuestions)(settings, batch, { signal: abort.signal });
          cancelled(abort);
          generated += answers.length;
          for (const answer of answers) {
            const q = batch.find(question => question.id === answer.id)!;
            state.results.push({ id: q.id,
              answer: answer.text || answer.optionIds?.map(id => q.options.find(o => o.id === id)?.text || id).join('；') || '',
              explanation: answer.explanation || '' });
          }
          if (settings.autoFill) {
            const current = await deps.frames(tabId);
            cancelled(abort);
            if (!current.some(item => item.frameId === frame.frameId && item.url === frame.url)) throw new Error('题目页面已切换，已停止填写和提交。');
            const applied = await deps.send(tabId, frame.frameId, { action: 'applyAnswers', questions: batch, answers }) as { applied?: number; skipped?: number; errors?: string[] };
            cancelled(abort);
            if (!applied || !Number.isInteger(applied.applied) || applied.applied! < 0 || applied.applied! > answers.length) throw new Error('未能确认答案已填入页面，已停止。');
            filled += applied.applied!;
            if (applied.applied !== answers.length) warnings.push('部分答案未填入，页面可能发生了变化。');
            if (Array.isArray(applied.errors)) warnings.push(...applied.errors.slice(0, 3));
          }
          state.completed += batch.length;
          publish(tabId);
        }
      }
      cancelled(abort);
      let submission = '';
      if (settings.autoSubmit) {
        if (filled !== state.total || generated !== state.total || unsupported || warnings.length || uncertainFrame) {
          submission = '有题目未识别、未回答或未填入，未自动提交。';
        } else {
          // Separate frames may contain independent forms: each must validate its full snapshot.
          for (const frame of usable) {
            cancelled(abort);
            const current = await deps.frames(tabId);
            cancelled(abort);
            if (!sameFrameSet(frames, current)) throw new Error('提交前页面或嵌入题目已变化，已停止。请重新识别全部题目。');
            state.message = '答案已填写，正在核对完整性并提交…';
            publish(tabId);
            const result = await deps.send(tabId, frame.frameId, { action: 'submitQuiz', questions: frame.questions, jobId: state.jobId }) as { submitted?: boolean; confirmed?: boolean; message?: string };
            if (!result || typeof result.submitted !== 'boolean') throw new Error('无法确认提交状态，请检查页面，勿重复提交。');
            submission += (result.message || '请检查平台提交结果。') + ' ';
            if (!result.submitted || !result.confirmed) break;
          }
        }
      }
      cancelled(abort);
      state.status = 'done';
      state.message = `${settings.autoFill ? `已填写 ${filled}/${state.total} 题。` : `已生成 ${generated}/${state.total} 题答案。`}${submission || (settings.autoFill ? '请检查页面答案。' : '仅展示答案，未填写或提交。')}${warnings.slice(0, 2).join(' ')}`;
    } catch (error) {
      state.status = abort.signal.aborted ? 'cancelled' : 'error';
      state.message = error instanceof Error ? error.message : 'AI 做题中断，请检查配置和页面后重试。';
    } finally { publish(tabId); }
  }
  return {
    start(tabId: number) {
      const previous = jobs.get(tabId);
      if (previous?.state.status === 'running') return { ...previous.state };
      const job = { state: { ...idle, jobId: `${tabId}-${Date.now()}-${++sequence}`, status: 'running' as const, message: '正在识别本页题目…', results: [] } as QuizJobState, abort: new AbortController() };
      jobs.set(tabId, job);
      publish(tabId);
      void driver(tabId, job);
      return { ...job.state };
    },
    get(tabId: number) { return jobs.get(tabId)?.state; },
    cancel(tabId: number) {
      const job = jobs.get(tabId);
      if (job?.state.status === 'running') {
        job.abort.abort();
        job.state.status = 'cancelled';
        job.state.message = '已停止后续做题；已经填写或提交的内容不会回滚。';
        publish(tabId);
        void deps.frames(tabId).then(frames => Promise.all(frames.map(frame =>
          deps.send(tabId, frame.frameId, { action: 'cancelQuiz', jobId: job.state.jobId }).catch(() => undefined)))).catch(() => undefined);
      }
      return job?.state || idle;
    },
    idle,
  };
}
