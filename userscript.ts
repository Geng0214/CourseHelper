import { bootContent } from "./controller";
import { normalizeSettings, solveQuestions, testConnection, type ApiSettings } from "./api";
import { mountPanel } from "./ui";
import type { QuizQuestion } from "./quiz";

type ValueListener = (key: string, before: unknown, value: unknown, remote: boolean) => void;
type GmResponse = { status: number; responseText: string; finalUrl?: string };
type GmRequest = {
  method: string; url: string; headers?: Record<string, string>; data?: string;
  anonymous: boolean; redirect: "error"; timeout: number;
  onload(value: GmResponse): void; onerror(): void; ontimeout(): void; onabort(): void;
};
declare function GM_getValue<T>(key: string, fallback: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_getTab(callback: (tab: Record<string, unknown>) => void): void;
declare function GM_saveTab(tab: Record<string, unknown>, callback?: () => void): void;
declare function GM_addValueChangeListener(key: string, listener: ValueListener): number;
declare function GM_removeValueChangeListener(id: number): void;
declare function GM_xmlhttpRequest(request: GmRequest): { abort(): void };
declare function GM_registerMenuCommand(label: string, callback: () => void): void;

type Platform = "chaoxing" | "rain";
type Status = { platform: Platform; enabled: boolean; autoNext: boolean; message: string; hasVideo: boolean; videoArea: number; playbackRate?: number };
type Session = { tab: string; page: string; platform: Platform };
type FrameCoverage = { origin: string; requiredOrigins: string[] };
type FrameState = { frame: string; at: number; status: Status; coverage?: FrameCoverage };
type LocalController = { handle(request: Record<string, unknown>): unknown };
type BusStorage = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  listen(key: string, listener: ValueListener): number;
  unlisten(id: number): void;
  keys?(): string[];
};
const SETTINGS_KEY = "courseHelper.apiSettings.v1";
const ACTIONS = new Set(["getStatus", "start", "pause", "setAutoNext", "setPlaybackRate", "getQuiz", "applyAnswers", "submitQuiz", "cancelQuiz"]);

function randomId() { return crypto.randomUUID(); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validStatus(value: unknown): value is Status {
  return record(value) && (value.platform === "chaoxing" || value.platform === "rain")
    && typeof value.enabled === "boolean" && typeof value.hasVideo === "boolean"
    && typeof value.autoNext === "boolean" && typeof value.message === "string"
    && typeof value.videoArea === "number" && Number.isFinite(value.videoArea);
}

/** Script-manager storage is private to this script, unlike window.postMessage. */
export function createFrameChannel(storage: BusStorage, session: Session, frame: string, controller: LocalController, describe?: () => FrameCoverage) {
  const prefix = `courseHelper.bus.${session.tab}`;
  const requestKey = `${prefix}.request`;
  const responseKey = `${prefix}.response`;
  const announceKey = `${prefix}.announce`;
  const cancelKey = `${prefix}.cancel`;
  const discoverKey = `${prefix}.discover`;
  const peers = new Map<string, FrameState>();
  const handled = new Set<string>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; detach(): void }>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let announcements = 0;

  // Requests contain question/answer data only while in flight. Remove expired
  // messages left by a crashed/closed browser whenever any script page opens.
  function pruneExpired() {
    for (const key of storage.keys?.() || []) {
      if (!key.startsWith("courseHelper.bus.")) continue;
      const value = storage.get<unknown>(key, null);
      if (record(value) && typeof value.expiresAt === "number" && value.expiresAt < Date.now()) storage.remove(key);
    }
  }
  pruneExpired();

  function cleanup(key: string, id: string) {
    const current = storage.get<unknown>(key, null);
    if (record(current) && current.id === id) storage.remove(key);
  }
  function announce() {
    if (closed) return;
    if (++announcements % 15 === 0) pruneExpired();
    const status = controller.handle({ type: "courseHelper", action: "getStatus", platform: session.platform });
    if (!validStatus(status)) return;
    const peer = { frame, status, at: Date.now(), ...(describe ? { coverage: describe() } : {}) };
    peers.set(frame, peer);
    storage.set(announceKey, { ...peer, page: session.page, expiresAt: Date.now() + 30000 });
  }
  const listeners = [
    storage.listen(announceKey, (_key, _before, value) => {
      if (!record(value) || value.page !== session.page || typeof value.frame !== "string"
        || !validStatus(value.status) || value.status.platform !== session.platform || typeof value.at !== "number") return;
      const coverage = record(value.coverage) && typeof value.coverage.origin === "string"
        && Array.isArray(value.coverage.requiredOrigins) && value.coverage.requiredOrigins.every(origin => typeof origin === "string")
        ? value.coverage as FrameCoverage : undefined;
      peers.set(value.frame, { frame: value.frame, status: value.status, at: value.at, coverage });
    }),
    storage.listen(discoverKey, (_key, _before, value) => {
      if (record(value) && value.page === session.page && typeof value.expiresAt === "number" && value.expiresAt >= Date.now()) announce();
    }),
    storage.listen(requestKey, (_key, _before, value) => {
      if (closed || !record(value) || value.page !== session.page || value.to !== frame
        || typeof value.id !== "string" || typeof value.action !== "string" || !ACTIONS.has(value.action)
        || !record(value.payload) || handled.has(value.id) || typeof value.expiresAt !== "number" || value.expiresAt < Date.now()) return;
      handled.add(value.id);
      if (handled.size > 100) handled.delete(handled.values().next().value!);
      const id = value.id;
      const reply = (result: unknown) => {
        const current = storage.get<unknown>(requestKey, null);
        if (!closed && record(current) && current.id === id && current.page === session.page) {
          storage.set(responseKey, { id, page: session.page, frame, result, expiresAt: Date.now() + 6000 });
        }
      };
      void Promise.resolve().then(() => {
        const current = storage.get<unknown>(requestKey, null);
        if (!record(current) || current.id !== id) return { error: "操作已取消。" };
        return controller.handle({ ...value.payload as Record<string, unknown>, type: "courseHelper", action: value.action, platform: session.platform });
      }).then(reply, () => reply({ error: "页面操作失败，请刷新课程页。" }))
        .finally(announce);
    }),
    storage.listen(responseKey, (_key, _before, value) => {
      if (!record(value) || value.page !== session.page || typeof value.id !== "string") return;
      const task = pending.get(value.id);
      if (!task) return;
      pending.delete(value.id);
      clearTimeout(task.timer);
      task.detach();
      cleanup(requestKey, value.id);
      cleanup(responseKey, value.id);
      task.resolve(value.result);
    }),
    storage.listen(cancelKey, (_key, _before, value) => {
      if (!record(value) || value.page !== session.page || (value.to !== frame && value.to !== "*")
        || typeof value.expiresAt !== "number" || value.expiresAt < Date.now()) return;
      controller.handle({ type: "courseHelper", action: "cancelQuiz", platform: session.platform });
    }),
  ];
  const heartbeat = setInterval(announce, 2000);
  announce();

  async function execute(target: string, action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (closed) throw new Error("页面连接已关闭，请刷新。");
    if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    if (!ACTIONS.has(action)) throw new Error("不支持的页面操作。");
    if (target === frame) {
      const result = await controller.handle({ ...payload, type: "courseHelper", action, platform: session.platform });
      announce();
      return result;
    }
    const id = randomId();
    return await new Promise((resolve, reject) => {
      const cancel = () => {
        const task = pending.get(id);
        if (!task) return;
        clearTimeout(task.timer); task.detach(); pending.delete(id);
        cleanup(requestKey, id); cleanup(responseKey, id);
        reject(new DOMException("操作已取消", "AbortError"));
      };
      const duration = action === "submitQuiz" ? 6500 : 4500;
      const timer = setTimeout(() => {
        pending.get(id)?.detach();
        pending.delete(id);
        cleanup(requestKey, id);
        cleanup(responseKey, id);
        reject(new Error("播放器框架未响应，请刷新页面后重试。"));
      }, duration);
      pending.set(id, { resolve, reject, timer, detach: () => signal?.removeEventListener("abort", cancel) });
      signal?.addEventListener("abort", cancel, { once: true });
      storage.set(requestKey, { id, page: session.page, to: target, action, payload, expiresAt: Date.now() + duration });
    });
  }
  function call(target: string, action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (action === "cancelQuiz") {
      // Cancellation has its own key and is never queued behind a submit dialog.
      if (closed) return Promise.resolve({ cancelled: true });
      if (target === frame || target === "*") controller.handle({ type: "courseHelper", action, platform: session.platform });
      storage.set(cancelKey, { id: randomId(), page: session.page, to: target, expiresAt: Date.now() + 6500 });
      return Promise.resolve({ cancelled: true });
    }
    const result = queue.then(() => execute(target, action, payload, signal));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  function knownFrames() {
    announce();
    return [...peers.values()]
      .sort((a, b) => Number(b.status.enabled) - Number(a.status.enabled)
        || Number(b.status.hasVideo) - Number(a.status.hasVideo) || b.status.videoArea - a.status.videoArea);
  }
  function frames() { return knownFrames().filter(peer => Date.now() - peer.at < 15000); }
  async function discover(signal?: AbortSignal, settleMs = 2250) {
    if (closed) throw new Error("页面连接已关闭，请刷新。");
    if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    storage.set(discoverKey, { id: randomId(), page: session.page, expiresAt: Date.now() + 6500 });
    // Children may still be waiting for the top document's tab session. Allow
    // their two-second reconnect check to run before taking a question snapshot.
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new DOMException("操作已取消", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, settleMs);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    if (closed) throw new Error("页面连接已关闭，请刷新。");
    return knownFrames();
  }
  function completeCoverage() {
    const known = knownFrames();
    if (known.some(peer => !peer.coverage)) return false;
    const required = new Map<string, number>();
    const available = new Map<string, number>();
    for (const peer of known) {
      for (const origin of peer.coverage!.requiredOrigins) required.set(origin, (required.get(origin) || 0) + 1);
      if (peer.frame !== frame) available.set(peer.coverage!.origin, (available.get(peer.coverage!.origin) || 0) + 1);
    }
    return [...required].every(([origin, count]) => (available.get(origin) || 0) >= count);
  }
  function close() {
    closed = true;
    clearInterval(heartbeat);
    for (const listener of listeners) storage.unlisten(listener);
    for (const [id, task] of pending) {
      clearTimeout(task.timer);
      task.detach();
      task.reject(new Error("页面已关闭。"));
      cleanup(requestKey, id);
      cleanup(responseKey, id);
    }
    pending.clear();
  }
  return { call, frames, knownFrames, discover, completeCoverage, close };
}

/** Adapter preserves aborts, omits browser cookies and rejects redirects. */
export function makeGmFetcher(requester: (request: GmRequest) => { abort(): void }) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return await new Promise<Response>((resolve, reject) => {
      if (init.signal?.aborted) { reject(new DOMException("请求已取消", "AbortError")); return; }
      let finished = false;
      let request: { abort(): void } | undefined;
      const finish = (error?: Error, result?: Response) => {
        if (finished) return;
        finished = true;
        init.signal?.removeEventListener("abort", cancel);
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(result!);
      };
      const cancel = () => {
        request?.abort();
        finish(new DOMException("请求已取消", "AbortError"));
      };
      // Fetch mode in some managers ignores their own timeout, so retain ours.
      const deadline = setTimeout(() => {
        request?.abort();
        finish(new Error("API 请求超时，请检查服务后重试。"));
      }, 60000);
      init.signal?.addEventListener("abort", cancel, { once: true });
      try {
        request = requester({
          method: init.method || "GET", url, headers,
          data: typeof init.body === "string" ? init.body : undefined,
          anonymous: true, redirect: "error", timeout: 60000,
          onload(value) {
            if (value.status < 200 || value.status > 599) { finish(new Error("API 未返回有效 HTTP 响应。")); return; }
            if (value.finalUrl && new URL(value.finalUrl).origin !== new URL(url).origin) {
              finish(new Error("API 跳转到其他域名，已停止读取响应。")); return;
            }
            if (value.responseText.length > 2_000_000) { finish(new Error("API 响应过大。")); return; }
            finish(undefined, new Response(value.responseText, { status: value.status }));
          },
          onerror: () => finish(new Error("无法连接 API，请检查地址或脚本管理器的连接授权。")),
          ontimeout: () => finish(new Error("API 请求超时，请重试。")),
          onabort: () => finish(new DOMException("请求已取消", "AbortError")),
        });
      } catch { finish(new Error("API 请求无法发出，请检查脚本管理器。")); }
    });
  };
}

type QuizAnswer = { id: string; optionIds?: string[]; text?: string; explanation?: string };
type QuizJob = { jobId?: string; status: "idle" | "running" | "done" | "error" | "cancelled"; message: string; completed: number; total: number; results: Array<{ id: string; answer: string; explanation: string }> };
type Channel = ReturnType<typeof createFrameChannel>;
const defaultJob = (): QuizJob => ({ status: "idle", message: "打开题目页后点击 AI 做本页题。", completed: 0, total: 0, results: [] });

export function createUserscriptRunner(channel: Channel, readSettings: () => ApiSettings, fetcher: typeof fetch) {
  let job = defaultJob();
  let abort: AbortController | null = null;
  async function run() {
    if (job.status === "running") return { jobId: job.jobId, status: job.status };
    let settings: ApiSettings;
    try { settings = normalizeSettings(readSettings()); }
    catch (error) { return { error: error instanceof Error ? error.message : "请先填写 API 设置。" }; }
    abort = new AbortController();
    const signal = abort.signal;
    job = { ...defaultJob(), jobId: randomId(), status: "running", message: "正在识别当前页面的题目…" };
    const activeJob = job;
    void (async () => {
      let applied = 0;
      let skipped = 0;
      let skippedScan = 0;
      let submitted = 0;
      const all: Array<{ frame: string; original: QuizQuestion; question: QuizQuestion }> = [];
      try {
        const discovered = await channel.discover(signal);
        const scannedFrames = new Set(discovered.map(peer => peer.frame));
        const unchangedFrames = () => {
          const current = channel.knownFrames();
          return current.length === scannedFrames.size && current.every(peer => scannedFrames.has(peer.frame));
        };
        for (const peer of discovered) {
          if (signal.aborted) return;
          const response = await channel.call(peer.frame, "getQuiz", {}, signal);
          if (signal.aborted) return;
          if (!record(response) || !Array.isArray(response.questions)) { skippedScan++; continue; }
          skippedScan += typeof response.skipped === "number" ? response.skipped : 0;
          for (const original of response.questions as QuizQuestion[]) {
            all.push({ frame: peer.frame, original, question: { ...original, id: `${peer.frame}::${original.id}` } });
          }
        }
        if (all.length === 0) throw new Error("本页没有识别到可填写的题目，请打开具体练习或作业。图片题与未适配题型需要手动处理。");
        if (all.length > 100) throw new Error("本页超过 100 道题，请分页面处理，避免一次发送过多请求。");
        activeJob.total = all.length;
        for (let index = 0; index < all.length; index += 4) {
          if (signal.aborted) return;
          const batch = all.slice(index, index + 4);
          activeJob.message = `正在回答 ${index + 1}–${Math.min(index + 4, all.length)} / ${all.length} 题…`;
          const response = await solveQuestions(settings, batch.map(item => item.question), { signal, fetcher });
          if (signal.aborted) return;
          const answers = response.answers as QuizAnswer[];
          for (const answer of answers) {
            const entry = batch.find(item => item.question.id === answer.id);
            if (!entry) continue;
            const text = answer.text || (answer.optionIds || []).map(id => entry.question.options.find(option => option.id === id)?.text || id).join("；");
            activeJob.results.push({ id: answer.id, answer: text, explanation: answer.explanation || "" });
          }
          if (settings.autoFill) {
            for (const target of new Set(batch.map(item => item.frame))) {
              if (signal.aborted) return;
              const entries = batch.filter(item => item.frame === target);
              const payloadAnswers = answers.flatMap(answer => {
                const entry = entries.find(item => item.question.id === answer.id);
                return entry ? [{ ...answer, id: entry.original.id }] : [];
              });
              const filled = await channel.call(target, "applyAnswers", {
                answers: payloadAnswers, questions: entries.map(item => item.original),
              }, signal);
              if (signal.aborted) return;
              if (record(filled)) {
                applied += typeof filled.applied === "number" ? filled.applied : 0;
                skipped += typeof filled.skipped === "number" ? filled.skipped : 0;
              }
            }
          }
          activeJob.completed = Math.min(index + batch.length, all.length);
        }
        activeJob.status = "done";
        activeJob.message = settings.autoFill
          ? `已生成 ${activeJob.results.length} 题答案，填写 ${applied} 题${skipped ? `，跳过 ${skipped} 题` : ""}。请检查后提交。`
          : `已生成 ${activeJob.results.length} 题答案，自动填写已关闭，请查看答案。`;
        if (settings.autoFill && settings.autoSubmit) {
          activeJob.status = "running";
          await channel.discover(signal, 150);
          if (signal.aborted) return;
          activeJob.status = "done";
          if (!unchangedFrames() || !channel.completeCoverage()) {
            activeJob.message += " 课程框架未全部连接或页面已变化，已停止自动提交。请刷新后重试或手动提交。";
          } else if (skippedScan || skipped || applied !== all.length || activeJob.results.length !== all.length) {
            activeJob.message += " 有未识别、未回答或未填写题目，已停止自动提交。";
          } else {
            activeJob.status = "running";
            activeJob.message = "全部题目已填写，正在确认并提交…";
            for (const target of new Set(all.map(item => item.frame))) {
              if (signal.aborted) return;
              if (!unchangedFrames() || !channel.completeCoverage()) {
                activeJob.status = "done";
                activeJob.message = "课程框架未全部连接或页面已变化，已停止后续自动提交，请检查页面。";
                return;
              }
              const response = await channel.call(target, "submitQuiz", { questions: all.filter(item => item.frame === target).map(item => item.original) }, signal);
              if (signal.aborted) return;
              if (record(response) && response.confirmed === true) submitted++;
              else {
                activeJob.status = "done";
                activeJob.message = `已填写 ${applied} 题，${record(response) && typeof response.message === "string" ? response.message : "未能确认提交，请检查页面。"}`;
                return;
              }
            }
            activeJob.status = "done";
            activeJob.message = `已填写 ${applied} 题并完成 ${submitted} 处提交，请查看平台结果。`;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        activeJob.status = "error";
        activeJob.message = error instanceof Error ? error.message : "答题失败，请检查 API 设置。";
      }
    })();
    return { jobId: job.jobId, status: job.status };
  }
  function cancel() {
    abort?.abort();
    void channel.call("*", "cancelQuiz").catch(() => { /* The page may already be closed. */ });
    if (job.status === "running") {
      job.status = "cancelled";
      job.message = "已停止后续答题与提交确认。已填写答案保留；已经发出的提交无法撤销，请查看页面。";
    }
    return { ...job };
  }
  return { run, cancel, status: () => ({ ...job, results: [...job.results] }) };
}

function showSettings(fetcher: typeof fetch) {
  const existing = document.getElementById("course-helper-script-settings");
  if (existing) { existing.remove(); return; }
  const host = document.createElement("div");
  host.id = "course-helper-script-settings";
  const shadow = host.attachShadow({ mode: "closed" });
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "课程助手 API 设置");
  const style = document.createElement("style");
  style.textContent = `:host{all:initial}dialog{color:#172134;background:#fff;border:1px solid #d6dce7;border-radius:12px;box-shadow:0 12px 50px #0003;padding:24px;width:min(420px,calc(100vw - 36px));font:14px/1.6 system-ui,sans-serif}dialog::backdrop{background:#0006}h2{margin:0 0 10px;font-size:19px}p{margin:8px 0;color:#526075}label{display:block;margin-top:12px}input[type=text],input[type=password],input[type=url]{display:block;box-sizing:border-box;width:100%;padding:9px;border:1px solid #bcc6d5;border-radius:6px;font:inherit}button{padding:9px 12px;margin:14px 8px 0 0;border:1px solid #a9b7cb;border-radius:6px;background:#f5f7fa;color:#172134;cursor:pointer;font:inherit}button.primary{background:#2459c2;color:white;border-color:#2459c2}button:disabled{opacity:.5}small{color:#526075}#message{min-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}input:focus-visible,button:focus-visible{outline:2px solid #2459c2;outline-offset:2px}`;
  shadow.append(style, dialog);
  const heading = document.createElement("h2"); heading.textContent = "连接自己的 AI API"; dialog.append(heading);
  const hint = document.createElement("p"); hint.textContent = "支持 OpenAI 兼容接口。点击 AI 做题时，当前题目与选项会发送到这里，可能产生服务费用。密钥只保存在脚本管理器中。"; dialog.append(hint);
  const saved = GM_getValue<Record<string, unknown>>(SETTINGS_KEY, {});
  const inputs: Record<string, HTMLInputElement> = {};
  for (const [key, labelText, type, placeholder] of [
    ["baseUrl", "API 地址", "url", "https://你的服务地址/v1"],
    ["apiKey", "API Key", "password", "在这里粘贴密钥"],
    ["model", "模型名称", "text", "填写服务提供的模型 ID"],
  ]) {
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement("input"); input.type = type; input.placeholder = placeholder;
    input.value = typeof saved[key] === "string" ? saved[key] as string : "";
    input.autocomplete = "off"; input.spellcheck = false;
    label.append(input); dialog.append(label); inputs[key] = input;
  }
  const checkLabel = document.createElement("label");
  const check = document.createElement("input"); check.type = "checkbox"; check.checked = saved.autoFill !== false;
  checkLabel.append(check, " AI 返回后自动填写"); dialog.append(checkLabel);
  const submitLabel = document.createElement("label");
  const submitCheck = document.createElement("input"); submitCheck.type = "checkbox"; submitCheck.checked = saved.autoSubmit !== false;
  submitCheck.disabled = !check.checked;
  check.addEventListener("change", () => { submitCheck.disabled = !check.checked; });
  submitLabel.append(submitCheck, " 全部题目成功填写后自动提交（有跳过时停止）"); dialog.append(submitLabel);
  const message = document.createElement("p"); message.id = "message"; message.setAttribute("role", "status"); dialog.append(message);
  const buttons = document.createElement("div"); dialog.append(buttons);
  function values() { return normalizeSettings({ baseUrl: inputs.baseUrl.value, apiKey: inputs.apiKey.value, model: inputs.model.value, autoFill: check.checked, autoSubmit: check.checked && submitCheck.checked }); }
  function button(label: string, callback: () => void) { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", callback); buttons.append(node); return node; }
  button("保存", () => {
    try { GM_setValue(SETTINGS_KEY, values()); message.textContent = "已保存。返回题目页，点击 AI 做本页题即可。"; inputs.apiKey.value = ""; host.remove(); }
    catch (error) { message.textContent = error instanceof Error ? error.message : "设置无效。"; }
  }).className = "primary";
  const test = button("测试连接", () => {
    let settings: ApiSettings;
    try { settings = values(); } catch (error) { message.textContent = error instanceof Error ? error.message : "设置无效。"; return; }
    test.disabled = true; message.textContent = "正在发送一条简短测试请求…";
    void testConnection(settings, { fetcher }).then(() => {
      message.textContent = "连接成功。点击保存后即可使用。";
    }).catch(error => { message.textContent = error instanceof Error ? error.message : "连接失败。"; }).finally(() => { test.disabled = false; });
  });
  button("清除密钥", () => { GM_deleteValue(SETTINGS_KEY); inputs.apiKey.value = ""; message.textContent = "已清除脚本保存的 API 设置。"; });
  button("关闭", () => host.remove());
  dialog.addEventListener("cancel", () => host.remove());
  document.documentElement.append(host); dialog.showModal(); inputs.baseUrl.focus();
}

async function readTab() { return await new Promise<Record<string, unknown>>(resolve => GM_getTab(resolve)); }
function sessionFrom(tab: Record<string, unknown>): Session | null {
  const value = tab.courseHelperSession;
  return record(value) && typeof value.tab === "string" && typeof value.page === "string"
    && (value.platform === "rain" || value.platform === "chaoxing") ? value as Session : null;
}

/** Only count visible course-platform frames; unrelated embeds are irrelevant. */
export function describeFrame(doc: Document, platform: Platform): FrameCoverage {
  const origin = doc.location.origin;
  const requiredOrigins: string[] = [];
  const documents = [doc];
  for (let index = 0; index < documents.length; index++) {
    for (const iframe of documents[index].querySelectorAll("iframe")) {
      const style = iframe.ownerDocument.defaultView?.getComputedStyle(iframe);
      if (!iframe.getClientRects().length || style?.display === "none" || style?.visibility === "hidden"
        || iframe.closest("[hidden],[aria-hidden='true']")) continue;
      try {
        const child = iframe.contentDocument;
        if (child && child.location.origin === origin) {
          if (!documents.includes(child)) documents.push(child);
          continue;
        }
      } catch { /* A cross-origin owner announces itself separately. */ }
      try {
        const url = new URL(iframe.getAttribute("src") || "about:blank", iframe.ownerDocument.baseURI);
        const domain = platform === "chaoxing" ? "chaoxing.com" : "yuketang.cn";
        if (url.protocol === "https:" && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))) requiredOrigins.push(url.origin);
      } catch { /* Invalid or unrelated embedded URL. */ }
    }
  }
  return { origin, requiredOrigins };
}

export async function startUserscript() {
  const controller = bootContent();
  if (!controller) return;
  const platform: Platform = location.hostname === "chaoxing.com" || location.hostname.endsWith(".chaoxing.com") ? "chaoxing" : "rain";
  const storage: BusStorage = { get: GM_getValue, set: GM_setValue, remove: GM_deleteValue, listen: GM_addValueChangeListener, unlisten: GM_removeValueChangeListener, keys: GM_listValues };
  const frameId = randomId();
  let channel: Channel | null = null;
  let session: Session | null = null;
  if (window === window.top) {
    const tab = await readTab();
    session = { tab: sessionFrom(tab)?.tab || randomId(), page: randomId(), platform };
    tab.courseHelperSession = session;
    // The manager documents an optional callback, but the panel does not need
    // to wait for persistence. Children poll the tab record until it is visible.
    GM_saveTab(tab);
    channel = createFrameChannel(storage, session, frameId, controller, () => describeFrame(document, platform));
    const fetcher = makeGmFetcher(GM_xmlhttpRequest);
    const runner = createUserscriptRunner(channel, () => normalizeSettings(GM_getValue(SETTINGS_KEY, {})), fetcher);
    GM_registerMenuCommand("课程助手 API 设置", () => showSettings(fetcher));
    mountPanel(async (request: Record<string, unknown>) => {
      if (request.action === "openOptions") { showSettings(fetcher); return { ok: true }; }
      if (request.action === "quizRun") return await runner.run();
      if (request.action === "quizStatus") return runner.status();
      if (request.action === "quizCancel") return runner.cancel();
      if (!channel || typeof request.action !== "string" || !ACTIONS.has(request.action)) return { error: "不支持的操作。" };
      const frames = request.action === "pause" ? channel.knownFrames() : channel.frames();
      if (request.action === "pause") {
        const results: unknown[] = [];
        let uncertain = false;
        for (const peer of frames) {
          try { results.push(await channel.call(peer.frame, "pause")); }
          catch { uncertain = true; }
        }
        if (uncertain || !channel.completeCoverage()) return { error: "部分播放器未能确认暂停，请在网页播放器中检查或刷新页面。" };
        if (results.some(status => !validStatus(status) || status.enabled)) return { error: "未能确认所有播放器已暂停，请检查网页播放器。" };
        return results.filter(validStatus).sort((a, b) => Number(b.hasVideo) - Number(a.hasVideo) || b.videoArea - a.videoArea)[0];
      }
      const selected = frames[0];
      if (!selected) return { error: "正在识别播放器，请稍后再试。" };
      if (request.action === "getStatus") return selected.status;
      return await channel.call(selected.frame, request.action, request);
    });
    window.addEventListener("pagehide", event => { runner.cancel(); if (!event.persisted) channel?.close(); });
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      void readTab().then(tab => { tab.courseHelperSession = session; GM_saveTab(tab); });
    });
  } else {
    // A child can load before the top document's idle callback. Recheck tab state
    // so it cannot remain attached to the previous document after navigation.
    let disposed = false;
    let connecting = false;
    let watcher: ReturnType<typeof setInterval> | undefined;
    const connect = async () => {
      if (disposed || connecting) return;
      connecting = true;
      try {
        const next = sessionFrom(await readTab());
        if (disposed || !next || next.platform !== platform || next.page === session?.page) return;
        channel?.close(); session = next;
        channel = createFrameChannel(storage, session, frameId, controller, () => describeFrame(document, platform));
      } finally { connecting = false; }
    };
    window.addEventListener("pagehide", event => {
      if (!event.persisted) { disposed = true; clearInterval(watcher); channel?.close(); }
    });
    window.addEventListener("pageshow", event => { if (event.persisted) void connect(); });
    await connect();
    if (!disposed) watcher = setInterval(() => { void connect(); }, 2000);
  }
}

if (typeof window !== "undefined" && typeof GM_getValue === "function") {
  void startUserscript().catch(() => { /* The manager or page was closed during initialization. */ });
}
