"use strict";
(() => {
  // popup.ts
  var panel = document.querySelector(".panel");
  var statusText = document.querySelector("#statusText");
  var platformName = document.querySelector("#platformName");
  var startButton = document.querySelector("#startButton");
  var pauseButton = document.querySelector("#pauseButton");
  var retryButton = document.querySelector("#retryButton");
  var autoNextCheckbox = document.querySelector("#autoNextCheckbox");
  var playbackRateSelect = document.querySelector("#playbackRateSelect");
  var settingsButton = document.querySelector("#settingsButton");
  var quizButton = document.querySelector("#quizButton");
  var cancelQuizButton = document.querySelector("#cancelQuizButton");
  var quizStatusText = document.querySelector("#quizStatusText");
  var quizRunning = false;
  var quizPolling = false;
  var quizVersion = 0;
  var currentState = null;
  var tabId;
  var busy = false;
  var polling = false;
  var initializing = false;
  var requestVersion = 0;
  var connectionMessage = "正在读取当前课程…";
  function updateControls() {
    panel.setAttribute("aria-busy", String(busy));
    startButton.disabled = busy || !currentState || currentState.enabled || currentState.hasVideo === false;
    pauseButton.disabled = busy || !currentState || !currentState.enabled;
    autoNextCheckbox.disabled = busy || !currentState;
    autoNextCheckbox.checked = currentState?.autoNext ?? false;
    playbackRateSelect.disabled = busy || !currentState;
    playbackRateSelect.value = String(currentState?.playbackRate ?? 1);
    if (!playbackRateSelect.value) playbackRateSelect.value = "1";
    quizButton.disabled = tabId === void 0 || quizRunning;
    cancelQuizButton.hidden = !quizRunning;
    retryButton.hidden = currentState !== null;
    retryButton.disabled = initializing || polling || busy;
    platformName.textContent = currentState ? `${currentState.platform === "chaoxing" ? "学习通" : "雨课堂"} · 已连接` : "自动识别学习通 / 雨课堂";
    const message = currentState?.message || connectionMessage;
    if (statusText.textContent !== message) statusText.textContent = message;
  }
  function isCourseStatus(value) {
    if (!value || typeof value !== "object") return false;
    return "enabled" in value && typeof value.enabled === "boolean" && "autoNext" in value && typeof value.autoNext === "boolean" && "message" in value && typeof value.message === "string" && "platform" in value && (value.platform === "chaoxing" || value.platform === "rain") && (!("hasVideo" in value) || typeof value.hasVideo === "boolean");
  }
  async function withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error("连接课程页面超时")), 8e3);
        })
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  }
  async function sendCommand(action, autoNext, playbackRate) {
    if (tabId === void 0) return;
    const isPoll = action === "getStatus";
    if (busy || isPoll && polling) return;
    if (!isPoll && !currentState) return;
    const version = isPoll ? requestVersion : ++requestVersion;
    if (isPoll) polling = true;
    else busy = true;
    updateControls();
    try {
      const response = await withTimeout(chrome.runtime.sendMessage({
        type: "courseHelperPopup",
        tabId,
        action,
        platform: currentState?.platform,
        autoNext,
        playbackRate
      }));
      if (version !== requestVersion) return;
      if (response && typeof response === "object" && "error" in response && typeof response.error === "string" && response.error.trim()) {
        currentState = null;
        connectionMessage = response.error;
        return;
      }
      if (!isCourseStatus(response)) throw new Error("课程页面返回了无法识别的状态");
      currentState = response;
    } catch {
      if (version !== requestVersion) return;
      currentState = null;
      connectionMessage = "无法连接课程页面。请打开学习通或雨课堂的视频章节。首次安装或更新后，刷新课程网页再重试。";
    } finally {
      if (isPoll) polling = false;
      else busy = false;
      updateControls();
    }
  }
  startButton.addEventListener("click", () => {
    void sendCommand("start");
  });
  pauseButton.addEventListener("click", () => {
    void sendCommand("pause");
  });
  autoNextCheckbox.addEventListener("change", () => {
    void sendCommand("setAutoNext", autoNextCheckbox.checked);
  });
  retryButton.addEventListener("click", () => {
    void initialize();
  });
  playbackRateSelect.addEventListener("change", () => {
    void sendCommand("setPlaybackRate", void 0, Number(playbackRateSelect.value));
  });
  async function sendQuiz(action) {
    if (tabId === void 0 || action === "quizStatus" && quizPolling) return;
    const isPoll = action === "quizStatus";
    const version = isPoll ? quizVersion : ++quizVersion;
    if (isPoll) quizPolling = true;
    else if (action === "quizRun") {
      quizRunning = true;
      quizStatusText.textContent = "正在读取本页题目…";
      updateControls();
    }
    try {
      const response = await withTimeout(chrome.runtime.sendMessage({ type: "courseHelperPopup", tabId, action }));
      if (version !== quizVersion) return;
      if (!response || typeof response !== "object") throw new Error("无法读取做题状态。");
      if ("error" in response && typeof response.error === "string") throw new Error(response.error);
      if (!("status" in response) || typeof response.status !== "string") throw new Error("做题状态无效，请重试。");
      quizRunning = response.status === "running";
      quizStatusText.textContent = "message" in response && typeof response.message === "string" ? response.message : quizRunning ? "正在分析题目…" : response.status === "done" ? "答案已处理，请在课程页检查。" : "已停止做题。";
    } catch (error) {
      if (version !== quizVersion) return;
      quizRunning = false;
      quizStatusText.textContent = error instanceof Error ? error.message : "做题失败，请检查 API 设置。";
    } finally {
      if (isPoll) quizPolling = false;
      updateControls();
    }
  }
  quizButton.addEventListener("click", () => {
    void sendQuiz("quizRun");
  });
  cancelQuizButton.addEventListener("click", () => {
    void sendQuiz("quizCancel");
  });
  settingsButton.addEventListener("click", () => {
    void withTimeout(chrome.runtime.sendMessage({ type: "courseHelperPopup", tabId, action: "openOptions" })).then((response) => {
      if (response && typeof response === "object" && "error" in response && typeof response.error === "string") quizStatusText.textContent = response.error;
    }, () => {
      quizStatusText.textContent = "设置未能打开，请重新加载扩展。";
    });
  });
  async function initialize() {
    if (initializing || busy || polling) return;
    initializing = true;
    connectionMessage = "正在读取当前课程…";
    updateControls();
    try {
      const tabs = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }));
      tabId = tabs[0]?.id;
      if (tabId === void 0) {
        currentState = null;
        connectionMessage = "没有找到当前标签页，请先打开课程网页，再点击重新连接。";
        return;
      }
      await sendCommand("getStatus");
    } catch {
      currentState = null;
      connectionMessage = "无法读取当前标签页，请重新打开插件。";
    } finally {
      initializing = false;
      updateControls();
    }
  }
  void initialize();
  window.setInterval(() => {
    if (!document.hidden && !initializing) void sendCommand("getStatus");
    if (!document.hidden && quizRunning) void sendQuiz("quizStatus");
  }, 1500);
})();
