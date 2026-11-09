export {};

type Settings = { baseUrl: string; apiKey: string; model: string; autoFill: boolean; autoSubmit: boolean };
const form = document.querySelector<HTMLFormElement>("#settingsForm")!;
const baseUrl = document.querySelector<HTMLInputElement>("#baseUrl")!;
const apiKey = document.querySelector<HTMLInputElement>("#apiKey")!;
const model = document.querySelector<HTMLInputElement>("#model")!;
const autoFill = document.querySelector<HTMLInputElement>("#autoFill")!;
const autoSubmit = document.querySelector<HTMLInputElement>("#autoSubmit")!;
const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
const testButton = document.querySelector<HTMLButtonElement>("#testButton")!;
const showKey = document.querySelector<HTMLButtonElement>("#showKey")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
let busy = false;
let edited = false;

function setStatus(message: string, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(value: boolean) {
  busy = value;
  saveButton.disabled = testButton.disabled = value;
  form.setAttribute("aria-busy", String(value));
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = value;
  autoSubmit.disabled = value || !autoFill.checked;
}

function readSettings(): { settings: Settings; origin: string } {
  const address = baseUrl.value.trim();
  let url: URL;
  try { url = new URL(address); } catch { baseUrl.focus(); throw new Error("请输入完整 API 地址，例如 https://你的服务地址/v1。"); }
  if (url.username || url.password || url.search || url.hash) {
    baseUrl.focus(); throw new Error("API 地址中不能包含用户名、密码、查询参数或片段，请把密钥填入 API Key。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    baseUrl.focus(); throw new Error("请使用 HTTPS API；本机 localhost 或 127.0.0.1 服务可使用 HTTP。");
  }
  if (!model.value.trim()) { model.focus(); throw new Error("请填写服务商支持的模型名称。"); }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return { settings: { baseUrl: url.href.replace(/\/$/, ""), apiKey: apiKey.value.trim(), model: model.value.trim(), autoFill: autoFill.checked, autoSubmit: autoFill.checked && autoSubmit.checked }, origin: `${url.origin}/*` };
}

async function message(action: string, settings?: Settings): Promise<Record<string, unknown>> {
  let timer: number | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: "courseHelperSettings", action, settings }),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("请求超时，请检查 API 地址与网络后重试。")), 65000); }),
    ]);
    if (!response || typeof response !== "object") throw new Error("扩展未能返回设置，请重新加载扩展后重试。");
    if ("error" in response && typeof response.error === "string") throw new Error(response.error);
    return response as Record<string, unknown>;
  } finally { window.clearTimeout(timer); }
}

function submit(test: boolean) {
  if (busy) return;
  let parsed: ReturnType<typeof readSettings>;
  try { parsed = readSettings(); } catch (error) { setStatus(error instanceof Error ? error.message : "请检查输入。", "error"); return; }
  // Must be invoked directly from the user's click/submit handler, before await.
  let permission: Promise<boolean>;
  try { permission = chrome.permissions.request({ origins: [parsed.origin] }); }
  catch { setStatus("无法请求 API 连接权限，请重新加载扩展后重试。", "error"); return; }
  setBusy(true);
  setStatus("正在确认 API 连接权限…");
  void (async () => {
    try {
      if (!await permission) throw new Error("未授予 API 域名权限，设置未保存。请再次点击保存并允许连接该域名。");
      await message("save", parsed.settings);
      if (test) {
        setStatus("设置已保存，正在测试连接…");
        const response = await message("test", parsed.settings);
        setStatus(typeof response.message === "string" ? response.message : "连接成功，可以返回课程页使用。", "success");
      } else setStatus("设置已保存。返回课程页，点击“AI 做本页题”即可。", "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "操作失败，请重试。", "error");
    } finally { setBusy(false); }
  })();
}

form.addEventListener("input", () => { edited = true; });
autoFill.addEventListener("change", () => {
  if (!autoFill.checked) autoSubmit.checked = false;
  autoSubmit.disabled = busy || !autoFill.checked;
});
for (const preset of form.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
  preset.addEventListener("click", () => {
    baseUrl.value = preset.dataset.preset || "";
    // A preset changes the destination. Never carry another provider's key over.
    apiKey.value = "";
    model.value = "";
    edited = true;
    apiKey.focus();
    setStatus("已填写地址。请填写对应服务的密钥和模型，再保存。");
  });
}
form.addEventListener("submit", event => { event.preventDefault(); submit(false); });
testButton.addEventListener("click", () => submit(true));
showKey.addEventListener("click", () => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  showKey.textContent = show ? "隐藏" : "显示";
  showKey.setAttribute("aria-pressed", String(show));
});

void message("get").then(response => {
  if (edited) return;
  const saved = (response.settings && typeof response.settings === "object" ? response.settings : response) as Partial<Settings>;
  baseUrl.value = typeof saved.baseUrl === "string" ? saved.baseUrl : "";
  apiKey.value = typeof saved.apiKey === "string" ? saved.apiKey : "";
  model.value = typeof saved.model === "string" ? saved.model : "";
  autoFill.checked = saved.autoFill !== false;
  autoSubmit.checked = autoFill.checked && saved.autoSubmit !== false;
  autoSubmit.disabled = !autoFill.checked;
  setStatus(baseUrl.value && model.value ? "设置已读取，可直接修改或测试连接。" : "填好 API 地址、密钥与模型，即可开始。");
}, () => { if (!edited) setStatus("无法读取设置，请重新加载扩展后打开此页面。", "error"); });
