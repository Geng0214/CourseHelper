import { scanQuizDetailed, applyAnswers, submitQuiz, type QuizQuestion } from './quiz';

export function bootContent() {
  // A single controller owns each same-origin frame tree. Cross-origin players
  // get their own controller, selected by the extension's message router.
  try {
    if (window !== window.top && window.parent.location.origin === location.origin) return null;
  } catch { /* A cross-origin frame must handle its own video. */ }

  type HelperState = { enabled: boolean; autoNext: boolean; courseKey: string; playbackRate: number };
  type HelperMessage = {
    type: "courseHelper";
    action: "getStatus" | "start" | "pause" | "setAutoNext" | "setPlaybackRate";
    platform?: "chaoxing" | "rain";
    autoNext?: boolean;
    playbackRate?: number;
  };

  const platform = location.hostname === "chaoxing.com" || location.hostname.endsWith(".chaoxing.com") ? "chaoxing" : "rain";
  const platformName = platform === "chaoxing" ? "学习通" : "雨课堂";
  const storageKey = platform === "chaoxing" ? "courseHelperChaoxingState" : "courseHelperRainState";
  let state: HelperState = { enabled: false, autoNext: false, courseKey: "", playbackRate: 1 };
  let message = `请打开${platformName}的视频学习页。`;
  let currentVideo: HTMLVideoElement | null = null;
  let videoEvents: AbortController | null = null;
  let navigationTimer: number | undefined;
  let missingSince = 0;
  let lastSource = "";
  let playRequest = 0;
  let resumeUntil = 0;
  let startedPage = location.href;
  const observedVideos = new Set<HTMLVideoElement>();
  const intersectingVideos = new WeakSet<Element>();
  // A cross-origin iframe cannot inspect its parent element. IntersectionObserver
  // accounts for ancestor clipping, so an invisible embedded player is not chosen.
  const visibilityObserver = window !== window.top && typeof IntersectionObserver === "function"
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) intersectingVideos.add(entry.target);
        else intersectingVideos.delete(entry.target);
      }
    }) : null;

  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && typeof saved === "object" && "enabled" in saved && "autoNext" in saved && "courseKey" in saved
      && typeof saved.enabled === "boolean" && typeof saved.autoNext === "boolean" && typeof saved.courseKey === "string") {
      const until = 'resumeUntil' in saved && typeof saved.resumeUntil === 'number' ? saved.resumeUntil : 0;
      state = { enabled: saved.enabled && until > Date.now() && until <= Date.now() + 30000,
        autoNext: saved.autoNext, courseKey: saved.courseKey,
        playbackRate: 'playbackRate' in saved && validRate(saved.playbackRate) ? saved.playbackRate : 1 };
      // A continuation is single-use; ordinary reloads never restart playback.
      sessionStorage.setItem(storageKey, JSON.stringify({ ...state, enabled: false, resumeUntil: 0 }));
    }
  } catch {
    message = "无法恢复上次状态，请手动开始播放。";
  }

  function saveState() {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ ...state, enabled: resumeUntil > Date.now() && state.enabled, resumeUntil }));
    } catch {
      message = "浏览器未允许保存状态，刷新页面后需要重新开始。";
    }
  }

  function validRate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 4;
  }

  function isVisible(element: Element) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return element.getClientRects().length > 0 && style?.visibility !== "hidden"
      && style?.display !== "none" && !element.closest("[hidden], [aria-hidden='true']");
  }

  function getDocuments() {
    const documents: Document[] = [document];
    // Cross-origin players have separate controllers; never read their DOM here.
    for (let index = 0; index < documents.length; index++) {
      for (const frame of documents[index].querySelectorAll("iframe")) {
        if (!isVisible(frame)) continue;
        try {
          const child = frame.contentDocument;
          if (child && child.location.origin === location.origin && !documents.includes(child)) documents.push(child);
        } catch {
          // 浏览器的跨域边界：忽略无法读取的 frame。
        }
      }
    }
    return documents;
  }

  function getVideos() {
    const videos = getDocuments().flatMap(doc => Array.from(doc.querySelectorAll("video")));
    for (const previous of observedVideos) {
      if (!videos.includes(previous)) {
        visibilityObserver?.unobserve(previous);
        observedVideos.delete(previous);
        intersectingVideos.delete(previous);
      }
    }
    return videos.filter(isVisible).filter(video => {
      if (!visibilityObserver) return true;
      if (!observedVideos.has(video)) {
        observedVideos.add(video);
        visibilityObserver.observe(video);
      }
      // Keep an already managed player reachable for Pause after it scrolls away.
      return (state.enabled && video === currentVideo) || intersectingVideos.has(video);
    })
      .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight);
  }

  function findVideo() {
    const videos = getVideos();
    return (currentVideo && videos.includes(currentVideo) ? currentVideo : videos[0]) ?? null;
  }

  function getCourseKey(video: HTMLVideoElement) {
    const urls = [new URL(location.href), new URL(video.ownerDocument.URL)];
    for (const url of urls) {
      if (platform === "chaoxing") {
        const courseId = url.searchParams.get("courseId") || url.searchParams.get("courseid");
        const classId = url.searchParams.get("clazzid");
        if (courseId && classId) return `${url.origin}/course/${courseId}/class/${classId}`;
      }
      const classroomId = url.searchParams.get("classroom_id") || url.pathname.match(/\/studentLog\/(\d+)/)?.[1];
      if (classroomId) return `${url.origin}/classroom/${classroomId}`;
      const coursePath = url.pathname.match(/^\/pro\/lms\/[^/]+\/[^/]+/)
        || url.pathname.match(/^\/ai-workspace\/lms-graph\/.*?(?=\/video\/)/);
      if (coursePath) return `${url.origin}${coursePath[0]}`;
    }
    // Unknown routes cannot establish that a new page is the same course.
    return "";
  }

  function stop(reason: string, pauseVideo = false) {
    playRequest++;
    state.enabled = false;
    resumeUntil = 0;
    window.clearTimeout(navigationTimer);
    navigationTimer = undefined;
    message = reason;
    saveState();
    if (pauseVideo && currentVideo?.isConnected && !currentVideo.paused) currentVideo.pause();
  }

  function formatTime(seconds: number) {
    if (!Number.isFinite(seconds)) return "--:--";
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  function getStatus() {
    const video = findVideo();
    if (state.enabled && video?.isConnected && !video.paused && !video.ended) {
      message = `播放中 ${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    }
    if (!state.enabled && (message.startsWith("请打开") || message.startsWith("请先进入") || message.startsWith("已找到视频"))) {
      message = video ? "已找到视频，点击开始 / 继续。" : `请先进入${platformName}的具体视频章节。`;
    }
    return { platform, enabled: state.enabled, autoNext: state.autoNext, message,
      playbackRate: state.enabled && video ? video.playbackRate : state.playbackRate,
      hasVideo: !!video, videoArea: video ? video.clientWidth * video.clientHeight : 0 };
  }

  function openNext(item: HTMLElement, video: HTMLVideoElement) {
    message = "视频已结束，正在打开下一节。";
    missingSince = Date.now();
    resumeUntil = state.courseKey ? Date.now() + 30000 : 0;
    saveState();
    item.click();
    navigationTimer = window.setTimeout(() => {
      if (state.enabled && currentVideo === video && video.ended) stop("下一节未能打开，请手动选择视频。");
    }, 15000);
  }

  function nextChaoxingVideo(video: HTMLVideoElement) {
    const pendingVideo = getVideos().find(item => item !== video && !item.ended
      && !item.ownerDocument.defaultView?.frameElement?.closest(".ans-job-finished"));
    if (pendingVideo) {
      bindVideo(pendingVideo);
      void playVideo(pendingVideo);
      return;
    }
    const unfinishedTask = getDocuments().some(doc => Array.from(doc.querySelectorAll(".ans-job-icon"))
      .some(item => isVisible(item) && !item.classList.contains("ans-job-icon-clear")));
    if (unfinishedTask) {
      stop("本节还有未完成的任务，请在页面中确认后继续。");
      return;
    }
    const chapters = Array.from(document.querySelectorAll("#coursetree h4"));
    const activeIndex = chapters.findIndex(item => item.classList.contains("currents"));
    const taskCount = chapters[activeIndex]?.querySelector(".jobCount")?.textContent?.trim() || "";
    if (/^\d+$/.test(taskCount) && Number(taskCount) > 0) {
      stop("学习通目录仍显示未完成任务，请确认本节任务后继续。");
      return;
    }
    const nextButton = document.querySelector<HTMLElement>("#right1");
    if (activeIndex < 0 || activeIndex >= chapters.length - 1 || !nextButton || !isVisible(nextButton)
      || nextButton.hasAttribute("disabled") || nextButton.getAttribute("aria-disabled") === "true") {
      stop("当前目录中没有可切换的下一节，请手动选择章节。");
      return;
    }
    openNext(nextButton, video);
  }

  function nextVideo(video: HTMLVideoElement) {
    if (!state.enabled || !state.autoNext || !video.isConnected || !video.ended || currentVideo !== video) return;
    if (platform === "chaoxing") {
      nextChaoxingVideo(video);
      return;
    }
    for (const doc of [video.ownerDocument, ...getDocuments()]) {
      const activeItems = doc.querySelectorAll<HTMLElement>(".leaf-item.is-active");
      if (activeItems.length !== 1) continue;
      // Stay inside the active list; do not jump into a second course/catalog.
      const items = Array.from(activeItems[0].parentElement?.querySelectorAll<HTMLElement>(".leaf-item") || []);
      const activeIndex = items.indexOf(activeItems[0]);
      if (activeIndex < 0) continue;
      for (const item of items.slice(activeIndex + 1)) {
        const kind = item.querySelector(".leaf-item-tag")?.textContent?.trim();
        if (kind !== "视频" || !isVisible(item)
          || item.classList.contains("is-disabled") || item.getAttribute("aria-disabled") === "true") {
          stop("下一项不是可播放视频，请手动选择下一节。");
          return;
        }
        if (item.querySelector("[class*='yuanquangou']")) continue;
        openNext(item, video);
        return;
      }
      stop("当前目录中没有下一段未完成视频。");
      return;
    }
    stop("视频已结束，当前目录结构尚未识别，请手动选择下一节。");
  }

  async function playVideo(video: HTMLVideoElement) {
    const request = ++playRequest;
    if (video.ended) {
      stop("当前视频已播放完，请选择下一节。");
      return;
    }
    try {
      video.playbackRate = state.playbackRate;
      await video.play();
      // 用户在 play() 等待期间暂停时，不能被迟到的 Promise 恢复播放。
      if ((!state.enabled || currentVideo !== video) && video.isConnected) video.pause();
    } catch {
      if (request === playRequest && state.enabled && currentVideo === video) {
        stop("播放未启动，请先在网页播放器中点击播放，再点开始/继续。");
      }
    }
  }

  function bindVideo(video: HTMLVideoElement) {
    videoEvents?.abort();
    videoEvents = new AbortController();
    currentVideo = video;
    lastSource = video.currentSrc || video.src;
    const options = { signal: videoEvents.signal };
    video.addEventListener("pause", () => {
      if (state.enabled && video.isConnected && video.paused && !video.ended) stop("播放已暂停。点击开始/继续可恢复。");
    }, options);
    video.addEventListener("error", () => {
      if (state.enabled) stop("视频加载失败，请检查网页播放器后重试。");
    }, options);
    video.addEventListener("ended", () => {
      if (!state.enabled) return;
      if (!state.autoNext) {
        stop("视频已播放结束。");
        return;
      }
      message = "视频已结束，等待页面记录进度。";
      window.clearTimeout(navigationTimer);
      navigationTimer = window.setTimeout(() => nextVideo(video), 3000);
    }, options);
  }

  function updateVideo() {
    if (!state.enabled) return;
    const unfinishedDialog = platform === "chaoxing" && document.querySelector("#jobFinishTip");
    if (unfinishedDialog && isVisible(unfinishedDialog)) {
      stop("学习通提示本节还有未完成任务，请先在页面中处理。");
      return;
    }
    const video = findVideo();
    if (!video) {
      missingSince ||= Date.now();
      if (Date.now() - missingSince > 15000) stop("当前页面未找到视频，请打开视频学习页后继续。");
      return;
    }
    if (getCourseKey(video) !== state.courseKey) {
      stop("课程页面已切换，请手动开始新课程。");
      return;
    }
    missingSince = 0;
    const source = video.currentSrc || video.src;
    if (!state.courseKey && (location.href !== startedPage || (currentVideo && currentVideo !== video)
      || (lastSource && source && lastSource !== source))) {
      stop("页面或视频已切换，无法确认课程，请手动开始。", true);
      return;
    }
    if (currentVideo === video && source === lastSource) return;
    window.clearTimeout(navigationTimer);
    resumeUntil = 0;
    saveState();
    bindVideo(video);
    void playVideo(video);
  }

  function handleMessage(request: HelperMessage) {
    if ((request.action === "start" || request.action === "setAutoNext" || request.action === "setPlaybackRate")
      && request.platform && request.platform !== platform) {
      return { ...getStatus(), message: `当前页面属于${platformName}，请重新打开扩展以识别平台。` };
    }
    if (request.action === "pause") stop("已暂停。", true);
    if (request.action === "setPlaybackRate") {
      if (!validRate(request.playbackRate)) return { ...getStatus(), message: '请选择 0.5–4 倍速。' };
      state.playbackRate = request.playbackRate;
      const video = findVideo();
      if (video) video.playbackRate = state.playbackRate;
      saveState();
      message = `已设为 ${state.playbackRate} 倍速。`;
    }
    if (request.action === "setAutoNext" && typeof request.autoNext === "boolean") {
      state.autoNext = request.autoNext;
      if (!state.autoNext) {
        window.clearTimeout(navigationTimer);
        if (currentVideo?.ended) stop("视频已播放结束。");
      }
      saveState();
    }
    if (request.action === "start") {
      const video = findVideo();
      if (!video) {
        stop("当前页面没有可播放视频，请先打开一个视频章节。");
      } else {
        state.enabled = true;
        resumeUntil = 0;
        state.courseKey = getCourseKey(video);
        startedPage = location.href;
        missingSince = 0;
        message = "正在启动视频。";
        window.clearTimeout(navigationTimer);
        bindVideo(video);
        saveState();
        void playVideo(video);
      }
    }
    return getStatus();
  }

  let quizSnapshot = new Map<string, { doc: Document; question: QuizQuestion }>();
  let submitAbort: AbortController | null = null;
  let submitJobId: string | null = null;
  function handleQuiz(request: Record<string, unknown>) {
    if (request.action === 'getQuiz') {
      quizSnapshot = new Map();
      const questions: QuizQuestion[] = [];
      let skipped = 0;
      const reasons: string[] = [];
      getDocuments().forEach((doc, index) => {
        const scan = scanQuizDetailed(doc);
        skipped += scan.skipped;
        reasons.push(...scan.reasons);
        for (const question of scan.questions) {
          const id = `d${index}:${question.id}`;
          quizSnapshot.set(id, { doc, question });
          questions.push({ ...question, id });
        }
      });
      return { questions, skipped, reasons };
    }
    if (request.action === 'submitQuiz') return submitSnapshot(request.questions, typeof request.jobId === 'string' ? request.jobId : null);
    if (!Array.isArray(request.answers) || !Array.isArray(request.questions)) {
      return { applied: 0, skipped: 0, errors: ['题目快照或答案无效，请重新识别。'] };
    }
    const result = { applied: 0, skipped: 0, errors: [] as string[] };
    const visibleDocuments = getDocuments();
    for (const answer of request.answers) {
      const original = answer && typeof answer.id === 'string' ? quizSnapshot.get(answer.id) : null;
      const expected = request.questions.find(q => q?.id === answer?.id);
      if (!original || !expected || !visibleDocuments.includes(original.doc)
        || JSON.stringify({ ...original.question, id: expected.id }) !== JSON.stringify(expected)) {
        result.skipped++;
        result.errors.push('题目页面已变化，已跳过对应答案。');
        continue;
      }
      const applied = applyAnswers(original.doc, [{ ...answer, id: original.question.id }], [original.question]);
      result.applied += applied.applied;
      result.skipped += applied.skipped;
      result.errors.push(...applied.errors);
    }
    return result;
  }

  async function submitSnapshot(expected: unknown, jobId: string | null) {
    submitAbort?.abort();
    submitAbort = new AbortController();
    submitJobId = jobId;
    const signal = submitAbort.signal;
    if (!Array.isArray(expected) || !expected.length || expected.length !== quizSnapshot.size) {
      return { submitted: false, message: '题目识别不完整，未自动提交。' };
    }
    const groups = new Map<Document, QuizQuestion[]>();
    for (const item of expected) {
      const original = quizSnapshot.get(item?.id);
      if (!original || !getDocuments().includes(original.doc)
        || JSON.stringify({ ...original.question, id: item.id }) !== JSON.stringify(item)) {
        return { submitted: false, message: '题目页面已变化，未自动提交。' };
      }
      const list = groups.get(original.doc) || [];
      list.push(original.question);
      groups.set(original.doc, list);
    }
    // Multiple independent answer forms are ambiguous: do not submit one by guessing.
    if (groups.size !== 1) return { submitted: false, message: '检测到多个独立答题页面，请分别打开后提交。' };
    const [doc, questions] = [...groups][0];
    return submitQuiz(doc, questions, signal);
  }

  // ACT: 单标签页每秒检查一次 SPA/同源 iframe 中的视频替换；只在用户启用后工作。
  window.setInterval(updateVideo, 1000);
  updateVideo();
  return {
    handle(request: Record<string, unknown>): unknown {
      try {
        if (request.action === 'cancelQuiz') {
          if (typeof request.jobId === 'string' && request.jobId !== submitJobId) {
            return { cancelled: false, message: '该任务已经结束，当前提交未受影响。' };
          }
          submitAbort?.abort();
          return { cancelled: true, message: '已停止后续提交确认，已发出的提交不能撤销。' };
        }
        if (request.action === 'getQuiz' || request.action === 'applyAnswers' || request.action === 'submitQuiz') return handleQuiz(request);
        if (!['getStatus', 'start', 'pause', 'setAutoNext', 'setPlaybackRate'].includes(String(request.action))) return;
        return handleMessage(request as HelperMessage);
      } catch {
        stop('页面操作失败，请刷新课程页面后重试。');
        return { ...getStatus(), error: '页面操作失败，请刷新课程页面后重试。' };
      }
    },
  };
}
