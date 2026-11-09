/** Local-only browser fixture. Never connects to a course account or remote API. */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.COURSE_HELPER_PREVIEW_PORT || process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Preview port must be 1–65535.');
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: root, entryPoints: ['userscript.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: ['chrome109'], charset: 'utf8', legalComments: 'none',
});

// This shim exists only in the local fixture, never in either distributable.
// The unmodified production userscript/controller/API/UI are bundled above.
const shim = `
(() => {
  const localOrigin = location.origin;
  const values = new Map([['courseHelper.apiSettings.v1', {
    baseUrl: localOrigin + '/v1', apiKey: '', model: 'mock', autoFill: true, autoSubmit: true
  }]]);
  const listeners = new Map();
  let sequence = 0;
  let tab = {};
  const clone = value => value === undefined ? value : structuredClone(value);
  window.GM_getValue = (key, fallback) => clone(values.has(key) ? values.get(key) : fallback);
  window.GM_setValue = (key, value) => {
    const before = values.get(key); values.set(key, clone(value));
    for (const item of listeners.values()) if (item.key === key) item.listener(key, clone(before), clone(value), false);
  };
  window.GM_deleteValue = key => {
    const before = values.get(key); values.delete(key);
    for (const item of listeners.values()) if (item.key === key) item.listener(key, clone(before), undefined, false);
  };
  window.GM_listValues = () => [...values.keys()];
  window.GM_addValueChangeListener = (key, listener) => { const id = ++sequence; listeners.set(id, { key, listener }); return id; };
  window.GM_removeValueChangeListener = id => listeners.delete(id);
  window.GM_getTab = callback => queueMicrotask(() => callback(clone(tab)));
  window.GM_saveTab = (value, callback) => { tab = clone(value); if (callback) queueMicrotask(callback); };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = request => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeout || 25000);
    let url;
    try {
      url = new URL(request.url);
      if (url.origin !== localOrigin || url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
        throw new Error('Preview permits only the local mock endpoint.');
      }
    } catch {
      clearTimeout(timeout); queueMicrotask(request.onerror); return { abort() {} };
    }
    const log = document.getElementById('network-status');
    log.textContent = '模拟 API：正在发送本机 HTTP 请求…';
    fetch(url.href, { method: 'POST', headers: request.headers, body: request.data,
      signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
      .then(async response => {
        const responseText = await response.text();
        log.textContent = '模拟 API：HTTP ' + response.status + '，响应已返回；没有连接外部服务。';
        request.onload({ status: response.status, responseText, finalUrl: response.url });
      })
      .catch(() => {
        log.textContent = controller.signal.aborted ? '模拟 API：请求已停止。' : '模拟 API：请求失败。';
        if (timedOut) request.ontimeout(); else if (controller.signal.aborted) request.onabort(); else request.onerror();
      }).finally(() => clearTimeout(timeout));
    return { abort() { controller.abort(); } };
  };

  const video = document.querySelector('video');
  const mediaStatus = document.getElementById('media-status');
  const mediaNote = document.getElementById('media-note');
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 260;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  let timer;
  let recordingTimer;
  let recorder;
  let stream;
  let blobUrl;
  let closed = false;
  let mediaMode = '初始化';
  function paint() {
    ctx.fillStyle = '#132d44'; ctx.fillRect(0, 0, 640, 260);
    ctx.fillStyle = '#b6e5ff'; ctx.font = '24px sans-serif'; ctx.fillText('本机生成的视频测试流', 32, 72);
    ctx.font = '16px sans-serif'; ctx.fillText('课程助手 · 播放 / 暂停 / 倍速控件验证', 32, 112);
    ctx.fillStyle = '#49b2f1'; ctx.fillRect(32 + frame++ % 490, 162, 64, 16);
  }
  function reportMedia() {
    mediaStatus.textContent = mediaMode + ' · ' + (video.paused ? '已暂停' : '播放中')
      + ' · 媒体时间 ' + video.currentTime.toFixed(2) + 's · playbackRate = ' + video.playbackRate + 'x';
  }
  function useLiveFallback() {
    if (closed) return;
    video.srcObject = stream;
    mediaMode = '实时流回退';
    mediaNote.textContent = '此浏览器无法录制测试短片，已回退 canvas 实时流。可测试播放、暂停及速率属性，不能证明录播倍速。';
    reportMedia();
  }
  if (ctx && typeof canvas.captureStream === 'function') {
    paint(); timer = setInterval(paint, 100); stream = canvas.captureStream(10);
    for (const event of ['play', 'pause', 'ratechange', 'timeupdate', 'loadeddata']) video.addEventListener(event, reportMedia);
    if (typeof MediaRecorder === 'function') {
      try {
        const type = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(value => MediaRecorder.isTypeSupported(value));
        recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        const chunks = [];
        mediaMode = '正在生成 4 秒录播短片'; reportMedia();
        mediaNote.textContent = '请等待约 4 秒生成本机短片，完成后可验证媒体时间按所选倍速推进。';
        recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener('error', useLiveFallback);
        recorder.addEventListener('stop', () => {
          if (closed) return;
          if (!chunks.length) { useLiveFallback(); return; }
          blobUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
          video.pause(); video.srcObject = null; video.src = blobUrl; video.loop = true; video.load();
          clearInterval(timer); stream.getTracks().forEach(track => track.stop());
          mediaMode = '本机录播短片';
          mediaNote.textContent = '已生成约 4 秒录播并循环播放。选择 1x / 2x / 4x，比较媒体时间推进速度；所有媒体数据保留在本页。';
          reportMedia();
        });
        recorder.start();
        recordingTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 4000);
      } catch { useLiveFallback(); }
    } else useLiveFallback();
  } else mediaStatus.textContent = '此浏览器不支持 canvas.captureStream；视频无源，仅可测试题目功能。';
  window.addEventListener('pagehide', () => {
    closed = true; clearInterval(timer); clearTimeout(recordingTimer);
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    document.getElementById('submission-result')?.remove();
    const success = document.querySelector('input[name=q1]:checked')?.value === 'B'
      && [...document.querySelectorAll('input[name=q2]:checked')].map(input => input.value).join(',') === 'A,C'
      && document.querySelector('textarea').value.trim() === '测试答案';
    const result = document.createElement('p'); result.id = 'submission-result';
    result.setAttribute('role', success ? 'status' : 'alert');
    result.textContent = success ? '提交成功：3 道模拟题均已正确填写，本机测试完成。' : '提交失败：请检查三道模拟题的答案。';
    event.currentTarget.append(result);
  });
})();
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>课程助手 · 本地测试页</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#172d41;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:1000px;margin:30px auto;padding:0 28px 70px}header{margin-bottom:22px}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:0 0 12px}p{margin:8px 0}.tag{color:#2563a7;font-weight:700;font-size:13px}section{background:white;border:1px solid #d9e3ed;border-radius:12px;padding:20px;margin:18px 0}
video{display:block;width:100%;max-width:640px;height:260px;background:#132d44;border-radius:8px}fieldset{border:1px solid #d3dfeb;border-radius:8px;margin:18px 0;padding:14px 18px}legend{font-weight:600;padding:0 6px}label{display:block;padding:5px 0;cursor:pointer}input{margin-right:8px}textarea{width:100%;min-height:74px;padding:8px;border:1px solid #9bb0c5;border-radius:6px;font:inherit}button{background:#2563a7;border:0;border-radius:7px;color:#fff;padding:10px 28px;font:inherit;cursor:pointer}#submission-result{font-weight:600;color:#17653c}.note{color:#516578;font-size:13px}.monitor{font-size:13px;color:#24536f}code{font-size:13px}
</style></head><body><main>
<header><p class="tag">CourseHelper 0.3 · 浏览器验收 fixture</p><h1>本地测试页，不是真实课程</h1>
<p>右下角运行真实课程助手面板。API 地址预设为本机，密钥为空，模型为 mock；不会访问真实账号或外部模型。</p>
<p class="note">测试内容：播放 / 暂停、倍速控件、API 设置，以及 AI 识别 → 本机 HTTP 请求 → 填写 → 提交。刷新页面会重置测试数据。</p></header>
<section><h2>视频控件</h2><video muted playsinline controls aria-label="本机视频测试流"></video>
<p id="media-status" class="monitor">正在初始化本机视频流…</p>
<p id="media-note" class="note">视频在浏览器中生成并录制为约 4 秒短片，用于验证媒体时间按所选倍速推进。</p></section>
<section><h2>本页模拟题 · 共 3 题</h2><p class="note">点击右下角“AI 做本页题”。默认启用自动填写与自动提交。</p>
<form>
<fieldset><legend>单选题：1 + 1 等于多少？</legend>
<label><input type="radio" name="q1" value="A">A. 1</label><label><input type="radio" name="q1" value="B">B. 2</label></fieldset>
<fieldset><legend>多选题：下列哪些数字是偶数？</legend>
<label><input type="checkbox" name="q2" value="A">A. 2</label><label><input type="checkbox" name="q2" value="B">B. 3</label><label><input type="checkbox" name="q2" value="C">C. 4</label></fieldset>
<fieldset><legend>简答题：请输入“测试答案”。</legend><textarea aria-label="简答题答案"></textarea></fieldset>
<button type="submit">提交</button>
</form><p id="network-status" class="monitor">模拟 API：等待请求。</p></section>
</main><script src="/shim.js"></script><script src="/bundle.js"></script></body></html>`;

function respond(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(body);
}

let requestCount = 0;
const server = createServer(async (request, response) => {
  // No CORS allowance or network proxy: only this loopback page may use the mock.
  if (request.headers.origin && request.headers.origin !== origin) return respond(response, 403, 'text/plain', 'Local fixture only.');
  const url = new URL(request.url || '/', origin);
  if (request.method === 'GET' && url.pathname === '/') return respond(response, 200, 'text/html', html);
  if (request.method === 'GET' && url.pathname === '/shim.js') return respond(response, 200, 'text/javascript', shim);
  if (request.method === 'GET' && url.pathname === '/bundle.js') return respond(response, 200, 'text/javascript', bundle.outputFiles[0].contents);
  if (request.method === 'GET' && url.pathname === '/health') return respond(response, 200, 'application/json', JSON.stringify({ localFixture: true, requestCount }));
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 100000) return respond(response, 413, 'text/plain', 'Fixture request too large.');
      }
      const input = JSON.parse(body);
      if (input.model !== 'mock') return respond(response, 400, 'application/json', JSON.stringify({ error: 'This fixture only supports model mock.' }));
      const prompt = input.messages?.findLast(message => message.role === 'user')?.content;
      let content = 'OK';
      if (typeof prompt === 'string' && prompt.trim().startsWith('{')) {
        const { questions } = JSON.parse(prompt);
        if (!Array.isArray(questions) || questions.length > 8) throw new Error('Invalid fixture questions.');
        content = JSON.stringify({ answers: questions.map(question => {
          const answer = { id: question.id, explanation: '本机模拟 API 的固定测试答案。' };
          if (question.type === 'text') answer.text = '测试答案';
          else if (question.type === 'multiple') answer.optionIds = question.options.filter(option => ['2', '4'].includes(option.text)).map(option => option.id);
          else answer.optionIds = question.options.filter(option => option.text === '2').slice(0, 1).map(option => option.id);
          return answer;
        }) });
      }
      requestCount++;
      // A short delay makes running/cancel UI observable without external services.
      await new Promise(resolve => setTimeout(resolve, 300));
      return respond(response, 200, 'application/json', JSON.stringify({ id: `mock-${requestCount}`, object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    } catch { return respond(response, 400, 'application/json', JSON.stringify({ error: 'Invalid local fixture request.' })); }
  }
  return respond(response, 404, 'text/plain', 'Not found.');
});
server.on('error', error => { console.error(`Preview failed: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local-only preview: ${origin}\nReal userscript bundle + test GM shim + local mock API. Press Ctrl+C to stop.`));
