type PanelTransport = (message: Record<string, unknown>) => Promise<unknown>;
type PanelStatus = { platform: "rain" | "chaoxing"; enabled: boolean; autoNext: boolean; message: string; hasVideo?: boolean; playbackRate?: number };
type QuizState = { status: string; message?: string; completed?: number; total?: number; results?: Array<{ id?: string; answer?: unknown; explanation?: string }> };

const rates = [0.5, 1, 1.25, 1.5, 2, 3, 4];

function errorMessage(value: unknown): string | null {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : null;
}

function isStatus(value: unknown): value is PanelStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PanelStatus>;
  return (s.platform === "rain" || s.platform === "chaoxing") && typeof s.enabled === "boolean"
    && typeof s.autoNext === "boolean" && typeof s.message === "string";
}

/** Shared by the browser extension and the userscript. No browser-specific APIs. */
export function mountPanel(transport: PanelTransport): void {
  if (document.getElementById("course-helper-panel")) return;
  const host = document.createElement("div");
  host.id = "course-helper-panel";
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000;display:block;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { color-scheme:light; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.5; color:#172336; }
      * { box-sizing:border-box; } [hidden] { display:none!important; }
      button,input,select { font:inherit; } button { cursor:pointer; }
      button { min-height:40px; padding:8px 12px; border:1px solid #bdc9da; border-radius:8px; background:#fff; color:#172336; transition:background .15s; }
      button:hover:not(:disabled) { background:#edf3fd; } button:disabled,select:disabled { opacity:.5; cursor:default; }
      button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible { outline:3px solid #8cb5ff; outline-offset:2px; }
      .primary { background:#2459c2; border-color:#2459c2; color:white; } .primary:hover:not(:disabled) { background:#174ba9; }
      .shell { width:min(328px,calc(100vw - 32px)); max-height:calc(100dvh - 84px); overflow:auto; background:#fff; border:1px solid #d4deec; border-radius:14px; box-shadow:0 8px 32px #14213a29; margin-bottom:8px; }
      header { display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid #e4eaf2; }
      header h2 { font-size:15px; margin:0; flex:1; } header button { min-height:36px; border:0; padding:6px 8px; color:#45607e; }
      main { padding:14px; } p { margin:0; overflow-wrap:anywhere; } .platform { color:#596c83; font-size:12px; margin-bottom:8px; }
      .status { padding:10px; border-radius:8px; background:#f3f6fb; min-height:56px; color:#344861; }
      .actions { display:flex; gap:8px; margin-top:10px; } .actions button { flex:1; }
      .settings-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:12px 0 4px; }
      .check { display:flex; align-items:center; gap:7px; cursor:pointer; min-height:36px; } input[type=checkbox] { width:17px; height:17px; accent-color:#2459c2; margin:0; }
      select { min-height:36px; padding:5px 8px; border:1px solid #bdc9da; border-radius:7px; background:#fff; color:#172336; }
      .divider { margin-top:12px; padding-top:12px; border-top:1px solid #e4eaf2; }
      .hint { font-size:12px; color:#596c83; margin-top:7px; }
      .quiz-status { font-size:13px; color:#344861; margin-top:8px; }
      .quiz-results { padding-left:20px; margin:8px 0 0; } .quiz-results li { padding:5px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
      details { font-size:12px; margin-top:8px; } summary { cursor:pointer; min-height:30px; }
      .launcher { display:block; margin-left:auto; min-height:44px; border-radius:22px; padding:8px 16px; box-shadow:0 3px 16px #14213a24; }
      @media(prefers-reduced-motion:reduce) { button { transition:none; } }
    </style>
    <section class="shell" id="shell" aria-label="课程助手控制面板">
      <header><h2>课程助手</h2><button id="settings" type="button">API 设置</button><button id="collapse" type="button" aria-label="收起课程助手">收起</button></header>
      <main>
        <p class="platform" id="platform">正在识别当前页面…</p>
        <p class="status" id="status" role="status" aria-live="polite">正在连接课程…</p>
        <div class="actions"><button id="start" class="primary" type="button" disabled>开始 / 继续</button><button id="pause" type="button" disabled>暂停</button></div>
        <div class="settings-row"><label class="check"><input id="next" type="checkbox" disabled>自动下一节</label><label>倍速 <select id="rate" aria-label="视频播放倍速" disabled>${rates.map(rate => `<option value="${rate}">${rate}×</option>`).join("")}</select></label></div>
        <div class="divider">
          <div class="actions" style="margin-top:0"><button id="quiz" class="primary" type="button">AI 做本页题</button><button id="cancel" type="button" hidden>停止</button></div>
          <p class="hint">题目发送到你的 API，按设置自动填写、提交。缺题或页面变化时停止。</p>
          <p id="quizStatus" class="quiz-status" role="status" aria-live="polite">首次使用请先配置 API。</p>
          <details id="results" hidden><summary>答案与解析</summary><ol id="resultList" class="quiz-results"></ol></details>
        </div>
      </main>
    </section>
    <button class="launcher primary" id="launcher" type="button" aria-expanded="true" aria-controls="shell">课程助手 · 收起</button>`;
  (document.body || document.documentElement).append(host);
  const element = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
  const shell = element<HTMLElement>("shell");
  const launcher = element<HTMLButtonElement>("launcher");
  const start = element<HTMLButtonElement>("start");
  const pause = element<HTMLButtonElement>("pause");
  const autoNext = element<HTMLInputElement>("next");
  const rate = element<HTMLSelectElement>("rate");
  const quiz = element<HTMLButtonElement>("quiz");
  const cancel = element<HTMLButtonElement>("cancel");
  const statusText = element<HTMLElement>("status");
  const quizText = element<HTMLElement>("quizStatus");
  let state: PanelStatus | null = null;
  let quizState: QuizState = { status: "idle" };
  let busy = false;
  let polling = false;
  let quizPolling = false;
  let version = 0;
  let quizVersion = 0;

  function controls() {
    start.disabled = busy || !state || state.enabled || state.hasVideo === false;
    pause.disabled = busy || !state || !state.enabled;
    autoNext.disabled = busy || !state;
    rate.disabled = busy || !state;
    autoNext.checked = state?.autoNext ?? false;
    rate.value = String(state?.playbackRate ?? 1);
    if (!rate.value) rate.value = "1";
    const running = quizState.status === "running";
    quiz.disabled = running;
    quiz.textContent = running ? "正在做题…" : "AI 做本页题";
    cancel.hidden = !running;
    element("platform").textContent = state ? `${state.platform === "rain" ? "雨课堂" : "学习通"} · 已连接` : "学习通 / 雨课堂";
  }

  async function call(message: Record<string, unknown>): Promise<unknown> {
    let timer: number | undefined;
    try {
      return await Promise.race([transport(message), new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("连接超时，请刷新课程页后重试。")), 10000);
      })]);
    } finally { window.clearTimeout(timer); }
  }

  async function command(action: string, extra: Record<string, unknown> = {}) {
    const isPoll = action === "getStatus";
    if (busy || (isPoll && polling)) return;
    const revision = isPoll ? version : ++version;
    if (isPoll) polling = true;
    else busy = true;
    controls();
    try {
      const response = await call({ action, ...extra });
      if (revision !== version) return;
      const error = errorMessage(response);
      if (error) throw new Error(error);
      if (!isStatus(response)) throw new Error("无法识别页面状态，请刷新后重试。");
      state = response;
      statusText.textContent = response.message;
    } catch (error) {
      if (revision !== version) return;
      state = null;
      statusText.textContent = error instanceof Error ? error.message : "无法连接课程页面。";
    } finally {
      if (isPoll) polling = false;
      else busy = false;
      controls();
    }
  }

  function renderQuiz(response: QuizState) {
    quizState = response;
    const progress = typeof response.total === "number" && typeof response.completed === "number"
      ? `（${response.completed}/${response.total}）` : "";
    if (response.message) quizText.textContent = `${response.message}${progress}`;
    else if (response.status === "running") quizText.textContent = `正在分析本页题目…${progress}`;
    else if (response.status === "done") quizText.textContent = "本次处理完成，请查看课程页提交状态。";
    else if (response.status === "cancelled") quizText.textContent = "已停止做题。";
    if (Array.isArray(response.results)) {
      const list = element<HTMLOListElement>("resultList");
      list.replaceChildren();
      for (const result of response.results) {
        const row = document.createElement("li");
        const answer = Array.isArray(result.answer) ? result.answer.join("、") : String(result.answer ?? "未提供答案");
        row.textContent = `${answer}${result.explanation ? `\n${result.explanation}` : ""}`;
        list.append(row);
      }
      element("results").hidden = response.results.length === 0;
    }
    controls();
  }

  async function quizCommand(action: string) {
    const isPoll = action === "quizStatus";
    if (isPoll && quizPolling) return;
    const revision = isPoll ? quizVersion : ++quizVersion;
    if (isPoll) quizPolling = true;
    else if (action === "quizRun") renderQuiz({ status: "running", message: "正在读取本页题目…", results: [] });
    else cancel.disabled = true;
    try {
      const response = await call({ action });
      if (revision !== quizVersion) return;
      const error = errorMessage(response);
      if (error) throw new Error(error);
      if (response && typeof response === "object" && "status" in response && typeof response.status === "string") {
        renderQuiz(response as QuizState);
      } else throw new Error("未能获取做题状态，请重试。");
    } catch (error) {
      if (revision !== quizVersion) return;
      renderQuiz({ status: "error", message: error instanceof Error ? error.message : "AI 做题失败，请检查 API 设置。" });
    } finally {
      if (isPoll) quizPolling = false;
      cancel.disabled = false;
    }
  }

  function toggle() {
    shell.hidden = !shell.hidden;
    launcher.setAttribute("aria-expanded", String(!shell.hidden));
    launcher.textContent = shell.hidden ? "课程助手" : "课程助手 · 收起";
    if (!shell.hidden) { void command("getStatus"); void quizCommand("quizStatus"); }
  }
  launcher.addEventListener("click", toggle);
  element("collapse").addEventListener("click", () => { toggle(); launcher.focus(); });
  start.addEventListener("click", () => { void command("start"); });
  pause.addEventListener("click", () => { void command("pause"); });
  autoNext.addEventListener("change", () => { void command("setAutoNext", { autoNext: autoNext.checked }); });
  rate.addEventListener("change", () => { void command("setPlaybackRate", { playbackRate: Number(rate.value) }); });
  quiz.addEventListener("click", () => { void quizCommand("quizRun"); });
  cancel.addEventListener("click", () => { void quizCommand("quizCancel"); });
  element("settings").addEventListener("click", () => {
    void call({ action: "openOptions" }).then(response => {
      const error = errorMessage(response);
      if (error) quizText.textContent = error;
    }, () => { quizText.textContent = "设置未能打开，请从扩展菜单进入 API 设置。"; });
  });
  const poll = () => {
    if (!host.isConnected) { window.clearInterval(interval); return; }
    if (document.hidden) return;
    if (!shell.hidden) void command("getStatus");
    if (quizState.status === "running" || !shell.hidden) void quizCommand("quizStatus");
  };
  let interval = window.setInterval(poll, 1500);
  window.addEventListener("pagehide", () => window.clearInterval(interval));
  window.addEventListener("pageshow", event => {
    if (event.persisted && host.isConnected) {
      window.clearInterval(interval);
      interval = window.setInterval(poll, 1500);
      poll();
    }
  });
  void command("getStatus");
  void quizCommand("quizStatus");
}
