import { normalizeSettings, endpointFor, testConnection } from './api';
import { createQuizJobs, type QuizJobState } from './quiz-jobs';

type Platform = "chaoxing" | "rain";
type Status = {
  platform: Platform; enabled: boolean; autoNext: boolean; message: string;
  hasVideo: boolean; videoArea: number;
};
type Action = "getStatus" | "start" | "pause" | "setAutoNext" | "setPlaybackRate" | "quizRun" | "quizCancel" | "quizStatus" | "openOptions";
type Request = { type: string; tabId: number; action: Action; autoNext?: boolean; platform?: Platform; playbackRate?: number };

function platformOf(url: string): Platform | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return null;
    if (hostname === "chaoxing.com" || hostname.endsWith(".chaoxing.com")) return "chaoxing";
    if (hostname === "yuketang.cn" || hostname.endsWith(".yuketang.cn")) return "rain";
  } catch { /* Invalid or browser-internal URL. */ }
  return null;
}

function validStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Status>;
  return (s.platform === "chaoxing" || s.platform === "rain") && typeof s.enabled === "boolean"
    && typeof s.autoNext === "boolean" && typeof s.message === "string" && typeof s.hasVideo === "boolean"
    && typeof s.videoArea === "number" && Number.isFinite(s.videoArea);
}

async function sendRaw(tabId: number, frameId: number, request: Record<string, unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { ...request, type: "courseHelper" }, { frameId }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("frame-timeout")), request.action === 'submitQuiz' ? 10000 : 2500); }),
    ]);
  } finally { clearTimeout(timeout); }
}

function send(tabId: number, frameId: number, action: Action, platform: Platform, autoNext?: boolean, playbackRate?: number) {
  return sendRaw(tabId, frameId, { action, platform, autoNext, playbackRate });
}

async function supportedFrames(tabId: number) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const platform = platformOf(frames?.find(frame => frame.frameId === 0)?.url || '');
  if (!platform) throw new Error('请先打开学习通或雨课堂的课程或题目页。');
  return frames!.filter(frame => platformOf(frame.url) === platform);
}

async function getApiSettings() {
  const saved = await chrome.storage.local.get('apiSettings');
  const settings = normalizeSettings(saved.apiSettings);
  if (!await chrome.permissions.contains({ origins: [new URL(endpointFor(settings.baseUrl)).origin + '/*'] })) {
    throw new Error('尚未授权该 API 站点，请打开 API 设置保存并授权。');
  }
  return settings;
}

const quizJobs = createQuizJobs({ settings: getApiSettings, frames: supportedFrames, send: sendRaw,
  save: (tabId, state) => chrome.storage.session.set({ [`quizJob:${tabId}`]: state }),
});

async function quizStatus(tabId: number) {
  const active = quizJobs.get(tabId);
  if (active) return active;
  const saved = (await chrome.storage.session.get(`quizJob:${tabId}`))[`quizJob:${tabId}`] as QuizJobState | undefined;
  if (!saved || !['running', 'done', 'error', 'cancelled'].includes(saved.status)) return quizJobs.idle;
  if (saved.status === 'running') {
    // No live driver can complete this task. Stop any surviving page confirmation
    // immediately instead of hiding the Stop button while it can still run.
    const frames = await supportedFrames(tabId).catch(() => []);
    if (saved.jobId) await Promise.all(frames.map(frame => sendRaw(tabId, frame.frameId,
      { action: 'cancelQuiz', jobId: saved.jobId }).catch(() => undefined)));
    const replacement = quizJobs.get(tabId);
    if (replacement) return replacement;
    const interrupted: QuizJobState = { ...saved, status: 'error', message: '浏览器后台已重启，已停止任务的后续确认。请检查已填写或已提交内容后重新开始。' };
    await chrome.storage.session.set({ [`quizJob:${tabId}`]: interrupted });
    return interrupted;
  }
  return saved;
}

async function route(request: Request) {
  if (request.action === 'openOptions') { await chrome.runtime.openOptionsPage(); return { message: '已打开 API 设置。' }; }
  if (request.action === 'quizRun') { await supportedFrames(request.tabId); return quizJobs.start(request.tabId); }
  if (request.action === 'quizStatus') return quizStatus(request.tabId);
  if (request.action === 'quizCancel') {
    if (quizJobs.get(request.tabId)) return quizJobs.cancel(request.tabId);
    // A restarted service worker has no in-memory job, while a content script
    // can still be waiting for a submission dialog. Cancel that exact saved job.
    const key = `quizJob:${request.tabId}`;
    const saved = (await chrome.storage.session.get(key))[key] as QuizJobState | undefined;
    if (!saved || saved.status !== 'running' || !saved.jobId) return quizJobs.idle;
    const frames = await supportedFrames(request.tabId).catch(() => []);
    await Promise.all(frames.map(frame => sendRaw(request.tabId, frame.frameId,
      { action: 'cancelQuiz', jobId: saved.jobId }).catch(() => undefined)));
    const stopped: QuizJobState = { ...saved, status: 'cancelled', message: '已停止重启前任务的后续提交确认；已经发出的提交无法撤销。' };
    await chrome.storage.session.set({ [key]: stopped });
    return stopped;
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId: request.tabId });
  const platform = platformOf(frames?.find(frame => frame.frameId === 0)?.url || "");
  if (!platform) return { error: "请先打开学习通或雨课堂的视频学习页，再点击扩展。" };
  const responses = await Promise.all(frames!.filter(frame => platformOf(frame.url) === platform).map(async frame => {
    try {
      const status = await send(request.tabId, frame.frameId, "getStatus", platform);
      return validStatus(status) && status.platform === platform ? { frameId: frame.frameId, status } : null;
    } catch { return null; /* Non-player frames need no controller. */ }
  }));
  const candidates = responses.filter(item => item !== null).sort((a, b) =>
    Number(b.status.enabled) - Number(a.status.enabled) || Number(b.status.hasVideo) - Number(a.status.hasVideo)
    || b.status.videoArea - a.status.videoArea || a.frameId - b.frameId);
  if (request.action === "pause") {
    // Discovery may have timed out for a still-playing frame. Try every supported
    // frame, including those that did not answer getStatus, before confirming stop.
    const results = await Promise.all(frames!.filter(frame => platformOf(frame.url) === platform).map(async frame => {
      try {
        const status = await send(request.tabId, frame.frameId, "pause", platform);
        return { status, absent: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: null, absent: /Receiving end does not exist|No matching message handler/i.test(message) };
      }
    }));
    if (results.some(item => !item.absent && (!validStatus(item.status) || item.status.enabled))) {
      return { error: "部分播放器未能确认暂停，请在网页播放器中检查并暂停。" };
    }
    const status = results.map(item => item.status).filter(validStatus)
      .sort((a, b) => Number(b.hasVideo) - Number(a.hasVideo) || b.videoArea - a.videoArea)[0];
    return status || { error: "未能确认暂停，请在网页播放器中暂停。" };
  }
  const selected = candidates[0];
  if (!selected) return { error: "尚未连接课程页面。首次安装或更新后，请刷新课程页，再打开扩展。" };
  if (request.action === "getStatus") return selected.status;
  if (request.platform && request.platform !== platform) return { ...selected.status, message: "页面平台已变化，请重新打开扩展。" };
  if (request.action === "start" && !selected.status.hasVideo) return selected.status;
  if (request.action === "setAutoNext" && typeof request.autoNext !== "boolean") return selected.status;
  if (request.action === 'setPlaybackRate' && (typeof request.playbackRate !== 'number'
    || !Number.isFinite(request.playbackRate) || request.playbackRate < 0.5 || request.playbackRate > 4)) {
    return { error: '请选择 0.5–4 倍速。' };
  }
  const result = await send(request.tabId, selected.frameId, request.action, platform, request.autoNext, request.playbackRate);
  return validStatus(result) ? result : { error: "课程页面状态无效，请刷新后重试。" };
}

chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !value || typeof value !== "object") return;
  if ('type' in value && value.type === 'courseHelperSettings') {
    // Secrets are exposed only to the extension's own settings document.
    // A trusted options document may itself be open in a browser tab. Its exact
    // extension URL and the checked sender ID establish trust, not tab absence.
    if (sender.url !== chrome.runtime.getURL('options.html')) return;
    void settingsMessage(value as Record<string, unknown>).then(respond, error => respond({ error: error instanceof Error ? error.message : '设置操作失败。' }));
    return true;
  }
  const request = value as Partial<Request>;
  if (request.type === 'courseHelperPanel') {
    if (!sender.tab || sender.frameId !== 0 || !platformOf(sender.url || '')) return;
    request.tabId = sender.tab.id;
  } else if (request.type !== 'courseHelperPopup' || sender.tab) return;
  if (!Number.isInteger(request.tabId) || request.tabId! < 0
    || !['getStatus', 'start', 'pause', 'setAutoNext', 'setPlaybackRate', 'quizRun', 'quizCancel', 'quizStatus', 'openOptions'].includes(String(request.action))) return;
  void route(request as Request).then(respond, () => respond({ error: "课程页面连接中断，请刷新页面后重试。" }));
  return true;
});

async function settingsMessage(request: Record<string, unknown>) {
  if (request.action === 'get') {
    const saved = await chrome.storage.local.get('apiSettings');
    return { settings: saved.apiSettings || { baseUrl: '', apiKey: '', model: '', autoFill: true, autoSubmit: true } };
  }
  if (request.action === 'save' || request.action === 'test') {
    const settings = normalizeSettings(request.settings);
    if (!await chrome.permissions.contains({ origins: [new URL(endpointFor(settings.baseUrl)).origin + '/*'] })) throw new Error('请允许设置页请求的 API 站点权限。');
    if (request.action === 'test') return testConnection(settings);
    await chrome.storage.local.set({ apiSettings: settings });
    return { message: '设置已保存。回到题目页，点击 AI 做题并提交即可。' };
  }
  return { error: '不支持的设置操作。' };
}

// Keys stay in trusted extension pages and never sync to an account or content script.
void chrome.storage?.local?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => undefined);
chrome.runtime.onInstalled?.addListener(details => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
