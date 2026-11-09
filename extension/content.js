"use strict";
(() => {
  // quiz.ts
  var ROOTS = ".TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item,.item-body,div[id^='question'],fieldset";
  var TITLE_SELECTORS = [".mark_name", ".Zy_TItle", ".question-title", ".question-stem", ".subject-title", ".problem-body", "legend", ".item-body", "h4", "h3"];
  var OPTION_WRAPPERS = ".answerBg,.Zy_ulTop > li,.question-options > li,.options > li,.item-body ul > li,.el-radio,.el-checkbox,[role=radio],[role=checkbox]";
  var TEXT_FIELDS = 'textarea,input[type=text],input:not([type]),[contenteditable="true"]';
  var MAX_QUESTIONS = 100;
  var MAX_TEXT = 12e3;
  var appliedSnapshots = /* @__PURE__ */ new WeakMap();
  function normalize(text) {
    return (text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
  function visible(element) {
    if (element.closest('[hidden],[aria-hidden="true"]')) return false;
    const view = element.ownerDocument.defaultView;
    for (let cursor = element; cursor; cursor = cursor.parentElement) {
      const style = view?.getComputedStyle(cursor);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    }
    return element.getClientRects().length > 0;
  }
  function blocked(element) {
    return element.matches(":disabled") || element.hasAttribute("readonly") || !!element.closest('[aria-disabled="true"],[aria-readonly="true"],.is-disabled,fieldset[disabled]');
  }
  function plainText(element, removeOptions = false) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script,style,[hidden],[aria-hidden="true"],input,textarea,button,.answer-analysis,.analysis,.answer-result,.correct-answer,.answer-feedback').forEach((node) => node.remove());
    if (removeOptions) clone.querySelectorAll(`${OPTION_WRAPPERS},label,ul,ol,[contenteditable]`).forEach((node) => node.remove());
    return normalize(clone.textContent);
  }
  function unsupportedContent(element) {
    return element.matches(".font-cxsecret,.font-cxsecret2") || !!element.querySelector(".font-cxsecret,.font-cxsecret2,canvas,img:not([aria-hidden='true']):not([role='presentation'])");
  }
  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
    return (result >>> 0).toString(36);
  }
  function optionText(target, input) {
    const content = target.querySelector(".answer_p,.option-content,.el-radio__label,.el-checkbox__label,a.after");
    let value = content ? plainText(content) : plainText(target);
    if (!value && input) value = normalize(input.getAttribute("aria-label"));
    return value.replace(/^[A-Z][.、．:：)）]\s*/, "").trim();
  }
  function findOptions(root) {
    const targets = [];
    const native = Array.from(root.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
    for (const input of native) {
      let target = input.closest(".answerBg,.Zy_ulTop > li,.question-options > li,.options > li,.el-radio,.el-checkbox") || input.closest("label") || input.closest("[role=radio],[role=checkbox]");
      if (!target) target = Array.from(input.labels || []).find((label) => root.contains(label)) || input;
      if (root.contains(target) && visible(target) && !blocked(target) && !blocked(input)) targets.push({ target, input });
    }
    for (const target of root.querySelectorAll(OPTION_WRAPPERS)) {
      if (!visible(target) || blocked(target)) continue;
      if (targets.some((existing) => existing.target === target || existing.target.contains(target) || target.contains(existing.target))) continue;
      if (target.querySelector("input:disabled,input[readonly]")) continue;
      targets.push({ target, input: target.querySelector('input[type="radio"],input[type="checkbox"]') });
    }
    targets.sort((a, b) => a.target.compareDocumentPosition(b.target) & 2 ? 1 : -1);
    const used = /* @__PURE__ */ new Set();
    return targets.map(({ target, input }, index) => {
      const marker = target.querySelector(".num_option[data]")?.getAttribute("data") || target.getAttribute("data-option-id") || input?.value;
      let id = marker && /^[A-Za-z0-9_-]{1,32}$/.test(marker) && marker !== "on" ? marker : String.fromCharCode(65 + index);
      if (used.has(id)) id = `option-${index + 1}`;
      used.add(id);
      return { id, text: optionText(target, input), target, input };
    });
  }
  function findFields(root) {
    const fields = Array.from(root.querySelectorAll(TEXT_FIELDS)).filter((field) => visible(field) && !blocked(field) && !field.closest(".answer-analysis,.analysis,.answer-feedback"));
    for (const iframe of root.querySelectorAll("iframe")) {
      if (!visible(iframe)) continue;
      try {
        const body = iframe.contentDocument?.body;
        if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true") && !blocked(body)) fields.push(body);
      } catch {
      }
    }
    return fields.filter((field) => !fields.some((other) => other !== field && other.contains(field)));
  }
  function inferType(root, text, options, fields) {
    const hint = `${root.getAttribute("data-question-type") || ""} ${root.querySelector(".subject-type,.question-type,.item-type,.type")?.textContent || ""} ${text}`;
    if (options.length >= 2) {
      if (/多选|multiple/i.test(hint) || options.some((option) => option.input?.type === "checkbox" || option.target.getAttribute("role") === "checkbox" || option.target.classList.contains("el-checkbox"))) return "multiple";
      if (/判断|boolean|true\s*\/\s*false/i.test(hint) || options.length === 2 && options.every((option) => /^(正确|错误|对|错|是|否|true|false|√|×)$/i.test(option.text))) return "boolean";
      if (/单选|single/i.test(hint) || options.every((option) => option.input?.type === "radio" || option.target.getAttribute("role") === "radio" || option.target.classList.contains("el-radio"))) return "single";
      return null;
    }
    if (fields.length && (/填空|简答|问答|论述|text|填入|回答/i.test(hint) || root.tagName === "FIELDSET")) return "text";
    return null;
  }
  function collect(doc) {
    const bindings = [];
    const reasons = [];
    const roots = Array.from(doc.querySelectorAll(ROOTS)).filter(visible).filter((root) => {
      if (root.matches(".TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item,fieldset")) return true;
      return !!root.querySelector(".Zy_TItle,.mark_name,.question-stem,.problem-body,h4");
    });
    const leaves = roots.filter((root) => !roots.some((other) => other !== root && root.contains(other)));
    let skipped = 0;
    for (const [index, root] of leaves.entries()) {
      if (bindings.length >= MAX_QUESTIONS) {
        skipped++;
        continue;
      }
      if (blocked(root) || unsupportedContent(root) || root.querySelector('input[type="radio"]:disabled,input[type="checkbox"]:disabled,[role="radio"][aria-disabled="true"],[role="checkbox"][aria-disabled="true"]')) {
        skipped++;
        reasons.push("图片、加密字体或不可编辑题目需要手动处理。");
        continue;
      }
      const title = TITLE_SELECTORS.map((selector) => root.querySelector(selector)).find(Boolean);
      let text = title ? plainText(title, true) : plainText(root, true);
      const options = findOptions(root);
      const fields = findFields(root);
      const type = inferType(root, text, options, fields);
      if (!type || !text || text.length > MAX_TEXT || type !== "text" && (options.length > 26 || options.some((option) => !option.text || option.text.length > MAX_TEXT))) {
        skipped++;
        reasons.push("题型、题干或选项无法可靠识别，已跳过。");
        continue;
      }
      if (type === "text" && fields.length > 1) text += `（共有 ${fields.length} 个答题框，请按顺序用 | 分隔各空答案。）`;
      const serialized = { type, text, options: type === "text" ? [] : options.map(({ id: id2, text: label }) => ({ id: id2, text: label })) };
      const route = `${doc.location?.origin || ""}${doc.location?.pathname || ""}`;
      const id = `q-${index + 1}-${hash(route + JSON.stringify(serialized))}`;
      bindings.push({ question: { id, ...serialized }, root, options: type === "text" ? [] : options, fields });
    }
    return { bindings, skipped, reasons: [...new Set(reasons)] };
  }
  function scanQuizDetailed(doc) {
    const result = collect(doc);
    return { questions: result.bindings.map((binding) => binding.question), skipped: result.skipped, reasons: result.reasons };
  }
  function checked(option) {
    if (option.input) return option.input.checked;
    const aria = option.target.getAttribute("aria-checked") || option.target.querySelector("[aria-checked]")?.getAttribute("aria-checked");
    if (aria) return aria === "true";
    return option.target.matches(".is-checked,.checked,.active,.Hover,.check_answer,.answer_checked") || !!option.target.querySelector(".is-checked,.checked,.Hover");
  }
  function setText(field, value) {
    const view = field.ownerDocument.defaultView;
    if (!view) throw new Error("答题框已离开当前页面。");
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      const prototype = field.tagName === "INPUT" ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    } else field.textContent = value;
    field.dispatchEvent(new view.Event("input", { bubbles: true }));
    field.dispatchEvent(new view.Event("change", { bubbles: true }));
  }
  function fieldValue(field) {
    return field.tagName === "INPUT" || field.tagName === "TEXTAREA" ? field.value : field.textContent || "";
  }
  function answerMatches(binding, answer) {
    if (binding.question.type === "text") {
      if (typeof answer.text !== "string") return false;
      const values = binding.fields.length > 1 ? answer.text.split("|").map((value) => value.trim()) : [answer.text];
      return values.length === binding.fields.length && binding.fields.every((field, index) => fieldValue(field) === values[index]);
    }
    const wanted = new Set(answer.optionIds || []);
    return wanted.size > 0 && binding.options.every((option) => checked(option) === wanted.has(option.id));
  }
  function applyAnswers(doc, answers, expected) {
    const result = { applied: 0, skipped: 0, errors: [] };
    const bindings = new Map(collect(doc).bindings.map((binding) => [binding.question.id, binding]));
    const snapshots = expected ? new Map(expected.map((question) => [question.id, question])) : null;
    const seen = /* @__PURE__ */ new Set();
    for (const answer of answers) {
      try {
        if (!answer || typeof answer.id !== "string" || seen.has(answer.id)) throw new Error("答案缺少题目编号或存在重复编号。");
        seen.add(answer.id);
        const binding = bindings.get(answer.id);
        if (!binding || !binding.root.isConnected || !visible(binding.root)) throw new Error("题目已变化或离开页面，请重新识别。");
        if (snapshots && JSON.stringify(snapshots.get(answer.id)) !== JSON.stringify(binding.question)) throw new Error("题目内容已变化，未填写旧答案。");
        if (binding.question.type === "text") {
          if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > MAX_TEXT) throw new Error("文本答案为空或过长。");
          const values = binding.fields.length > 1 ? answer.text.split("|").map((value) => value.trim()) : [answer.text];
          if (values.length !== binding.fields.length || values.some((value) => !value)) throw new Error("答案数量与填空数量不一致。");
          if (binding.fields.some(blocked)) throw new Error("答题框不可编辑。");
          binding.fields.forEach((field, index) => setText(field, values[index]));
        } else {
          if (!Array.isArray(answer.optionIds) || !answer.optionIds.length || answer.optionIds.some((id) => typeof id !== "string")) throw new Error("选择题答案缺少有效选项。");
          const wanted = new Set(answer.optionIds);
          if (wanted.size !== answer.optionIds.length || binding.question.type !== "multiple" && wanted.size !== 1) throw new Error("选项数量与题型不符。");
          if ([...wanted].some((id) => !binding.options.some((option) => option.id === id))) throw new Error("答案包含页面中不存在的选项。");
          if (binding.options.some((option) => blocked(option.target) || option.input && blocked(option.input))) throw new Error("选项当前不可编辑。");
          for (const option of binding.options) {
            const select = wanted.has(option.id);
            if (select === checked(option) || !select && binding.question.type !== "multiple") continue;
            (option.input || option.target).click();
          }
        }
        if (!answerMatches(binding, answer)) throw new Error("页面未确认答案已填入，请检查控件状态后重试。");
        if (!appliedSnapshots.has(doc)) appliedSnapshots.set(doc, /* @__PURE__ */ new Map());
        appliedSnapshots.get(doc).set(answer.id, { id: answer.id, optionIds: answer.optionIds ? [...answer.optionIds] : void 0, text: answer.text });
        result.applied++;
      } catch (error) {
        result.skipped++;
        result.errors.push(error instanceof Error ? error.message : "此题填写失败，请手动检查。");
      }
    }
    result.errors = [...new Set(result.errors)];
    return result;
  }
  var SUBMIT_LABEL = /^(提交|提交答案|提交作业|交卷|提交试卷|确认交卷)$/;
  var CONFIRM_LABEL = /^(确定|确认|确认提交|确定提交|提交|交卷|确认交卷|确定交卷)$/;
  var BUTTONS = 'button,input[type="submit"],input[type="button"],a[role="button"],a[onclick],a[href^="javascript:"],[role="button"],.submitBtn,.submit-btn,#submitWork,#submitTest,.jb_btn,.jb_btn_bg';
  var DIALOGS = '[role="dialog"],dialog[open],.el-message-box,.layui-layer-dialog,.ui-dialog,.artDialog';
  function buttonLabel(element) {
    const value = element.tagName === "INPUT" ? element.value : element.textContent;
    return normalize(value || element.getAttribute("aria-label")).replace(/\s/g, "");
  }
  function buttonCandidates(scope, labels) {
    const elements = Array.from(scope.querySelectorAll(BUTTONS)).filter((element) => visible(element) && !blocked(element) && labels.test(buttonLabel(element)));
    return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
  }
  var OUTCOME_NODES = '.submit-success,.success-message,.el-message--success,[data-submit-success="true"],[role="status"],h1,h2,.el-message--error,.error-message,[role="alert"]';
  function submitOutcome(doc, before) {
    const successNodes = doc.querySelectorAll('.submit-success,.success-message,.el-message--success,[data-submit-success="true"],[role="status"],h1,h2');
    if (Array.from(successNodes).some((node) => visible(node) && before.get(node) !== normalize(node.textContent) && /提交成功|交卷成功|成功提交|作业已提交|试卷已提交/.test(normalize(node.textContent)))) {
      return { submitted: true, confirmed: true, message: "页面显示提交成功。" };
    }
    const errorNodes = doc.querySelectorAll('.el-message--error,.error-message,[role="alert"]');
    const failure = Array.from(errorNodes).find((node) => visible(node) && before.get(node) !== normalize(node.textContent) && /提交失败|交卷失败|还有.*未.*答|存在.*未.*答|请完成.*答题/.test(normalize(node.textContent)));
    if (failure) return { submitted: false, confirmed: false, message: `页面未接受提交：${normalize(failure.textContent).slice(0, 180)}` };
    return null;
  }
  function confirmationCandidates(doc) {
    const dialogs = Array.from(doc.querySelectorAll(DIALOGS)).filter(visible).filter((dialog) => /提交|交卷/.test(normalize(dialog.textContent)));
    const topDialogs = dialogs.filter((dialog) => !dialogs.some((other) => other !== dialog && other.contains(dialog)));
    if (!topDialogs.length) return null;
    if (topDialogs.length !== 1) return [];
    return buttonCandidates(topDialogs[0], CONFIRM_LABEL);
  }
  function answerComplete(binding) {
    if (binding.question.type === "text") {
      return binding.fields.length > 0 && binding.fields.every((field) => {
        if (blocked(field)) return false;
        return normalize(field.tagName === "INPUT" || field.tagName === "TEXTAREA" ? field.value : field.textContent).length > 0;
      });
    }
    const selected = binding.options.filter(checked);
    return binding.question.type === "multiple" ? selected.length > 0 : selected.length === 1;
  }
  function incompletePaper(doc, expectedCount, form) {
    const controls = 'input[type="radio"],input[type="checkbox"],input[type="text"],textarea,[contenteditable="true"],[role="radio"],[role="checkbox"],.answerBg,.Zy_ulTop li,.el-radio,.el-checkbox';
    for (const root of doc.querySelectorAll(ROOTS)) {
      if (visible(root)) continue;
      const title = TITLE_SELECTORS.map((selector) => root.querySelector(selector)).find(Boolean);
      const clearQuestion = root.matches(".TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item") || /单选|多选|判断|填空|简答|问答|论述/.test(normalize(title?.textContent)) || !!root.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]');
      if (clearQuestion && title && normalize(title.textContent) && root.querySelector(controls)) {
        return "页面还包含未显示的题目，无法确认整卷完整，请检查其它题目后手动提交。";
      }
    }
    const paginationSelector = '.pagination,.el-pagination,.pagebar,.pageNav,.question-pagination,.exam-pagination,[aria-label*="分页"]';
    const navigation = Array.from(doc.querySelectorAll('button,a,[role="button"],input[type="button"]')).filter((element) => visible(element) && !blocked(element));
    if (navigation.some((element) => buttonLabel(element) === "下一题" || buttonLabel(element) === "下一页" && (!!form?.contains(element) || !!element.closest(".question-pagination,.exam-pagination") || !form && !!element.closest(paginationSelector)))) {
      return "当前页面仍可切换题目或试卷分页，无法确认整卷完整，请完成其它页后手动提交。";
    }
    const cards = doc.querySelectorAll('.answer-card,.answerCard,.answer-card-list,.answerSheet,.answer-sheet,.answercard,[aria-label*="答题卡"]');
    for (const card of cards) {
      if (!visible(card)) continue;
      const unfilled = card.querySelectorAll('[aria-label*="未答"],.unanswered,.not-answered,.notAnswer,.not-answer,.undone,[data-answer-status="unanswered"]');
      if (Array.from(unfilled).some(visible) || /未(?:作)?答\s*[:：]?\s*[（(]?\s*[1-9]\d*/.test(normalize(card.textContent))) {
        return "答题卡仍显示未作答题目，自动提交已停止，请先完成整卷。";
      }
    }
    const summaries = doc.querySelectorAll('.answer-card,.answerCard,.answercard,.paper-info,.test-info,.exam-info,.question-count,[aria-label*="答题卡"]');
    for (const summary of summaries) {
      if (!visible(summary)) continue;
      const total = normalize(summary.textContent).match(/共\s*(\d+)\s*(?:道)?题/);
      if (total && Number(total[1]) > expectedCount) return "试卷总题数多于当前识别题数，自动提交已停止，请检查其它页面。";
    }
    return null;
  }
  async function waitForPage(doc, milliseconds, signal) {
    if (signal?.aborted || !doc.defaultView) return;
    await new Promise((resolve) => {
      const finish = () => {
        doc.defaultView?.clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = doc.defaultView.setTimeout(finish, milliseconds);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
  async function submitQuiz(doc, expected, signal) {
    const stop = (message) => ({ submitted: false, confirmed: false, message });
    let dispatched = false;
    const cancellation = () => signal?.aborted ? { submitted: dispatched, confirmed: false, message: "已停止后续提交确认；已经发出的提交无法撤销。" } : null;
    const alreadyCancelled = cancellation();
    if (alreadyCancelled) return alreadyCancelled;
    let current = collect(doc);
    const questions = current.bindings.map((binding) => binding.question);
    if (!expected.length || current.skipped || questions.length !== expected.length || new Set(expected.map((question) => question.id)).size !== expected.length) {
      return stop("未能确认全部题目均已识别，自动提交已停止，请检查页面。");
    }
    const snapshots = new Map(expected.map((question) => [question.id, question]));
    if (questions.some((question) => JSON.stringify(snapshots.get(question.id)) !== JSON.stringify(question))) {
      return stop("题目或选项已经变化，自动提交已停止，请重新识别。");
    }
    if (!current.bindings.every(answerComplete)) await waitForPage(doc, 50, signal);
    const afterWaitCancelled = cancellation();
    if (afterWaitCancelled) return afterWaitCancelled;
    current = collect(doc);
    if (current.skipped || current.bindings.length !== expected.length || current.bindings.some((binding) => JSON.stringify(snapshots.get(binding.question.id)) !== JSON.stringify(binding.question))) {
      return stop("题目或选项已经变化，自动提交已停止，请重新识别。");
    }
    if (!current.bindings.every((binding) => binding.root.isConnected && visible(binding.root) && answerComplete(binding))) {
      return stop("仍有题目未填写，或无法确认选中状态，自动提交已停止。");
    }
    if (current.bindings.some((binding) => {
      const previouslyApplied = appliedSnapshots.get(doc)?.get(binding.question.id);
      return previouslyApplied && !answerMatches(binding, previouslyApplied);
    })) return stop("填写后的答案状态已变化，自动提交已停止，请检查页面答案。");
    const before = new Map(Array.from(doc.querySelectorAll(OUTCOME_NODES)).map((node) => [node, normalize(node.textContent)]));
    const forms = new Set(current.bindings.map((binding) => binding.root.closest("form")));
    if (forms.size > 1) return stop("题目属于多个表单，无法确定提交范围，请手动提交。");
    const form = [...forms][0] || null;
    const scope = form || doc;
    const incomplete = incompletePaper(doc, expected.length, form);
    if (incomplete) return stop(incomplete);
    let confirmedDialog = false;
    const confirmOnce = () => {
      const cancelled = cancellation();
      if (cancelled) return cancelled;
      const controls = confirmationCandidates(doc);
      if (controls === null) return null;
      if (controls.length !== 1) return stop("提交确认框不明确，请在页面中手动确认。");
      if (confirmedDialog) return stop("页面出现了额外确认步骤，请手动检查后继续。");
      dispatched = true;
      controls[0].click();
      confirmedDialog = true;
      return null;
    };
    const existingConfirm = confirmationCandidates(doc);
    if (existingConfirm !== null) {
      const failure = confirmOnce();
      if (failure) return failure;
    } else {
      const candidates = buttonCandidates(scope, SUBMIT_LABEL).filter((button) => !button.closest(DIALOGS));
      if (candidates.length !== 1) return stop("没有找到唯一可用的提交按钮，请在页面中手动提交。");
      const beforeClickCancelled = cancellation();
      if (beforeClickCancelled) return beforeClickCancelled;
      dispatched = true;
      candidates[0].click();
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const cancelled = cancellation();
      if (cancelled) return cancelled;
      const outcome = submitOutcome(doc, before);
      if (outcome) return outcome;
      if (!confirmedDialog) {
        const failure = confirmOnce();
        if (failure) return failure;
        const afterConfirm = submitOutcome(doc, before);
        if (afterConfirm) return afterConfirm;
      }
      await waitForPage(doc, 100, signal);
    }
    const finallyCancelled = cancellation();
    if (finallyCancelled) return finallyCancelled;
    return { submitted: true, confirmed: false, message: "已发起提交，请以页面结果为准。" };
  }

  // controller.ts
  function bootContent() {
    try {
      if (window !== window.top && window.parent.location.origin === location.origin) return null;
    } catch {
    }
    const platform = location.hostname === "chaoxing.com" || location.hostname.endsWith(".chaoxing.com") ? "chaoxing" : "rain";
    const platformName = platform === "chaoxing" ? "学习通" : "雨课堂";
    const storageKey = platform === "chaoxing" ? "courseHelperChaoxingState" : "courseHelperRainState";
    let state = { enabled: false, autoNext: false, courseKey: "", playbackRate: 1 };
    let message = `请打开${platformName}的视频学习页。`;
    let currentVideo = null;
    let videoEvents = null;
    let navigationTimer;
    let missingSince = 0;
    let lastSource = "";
    let playRequest = 0;
    let resumeUntil = 0;
    let startedPage = location.href;
    const observedVideos = /* @__PURE__ */ new Set();
    const intersectingVideos = /* @__PURE__ */ new WeakSet();
    const visibilityObserver = window !== window.top && typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) intersectingVideos.add(entry.target);
        else intersectingVideos.delete(entry.target);
      }
    }) : null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object" && "enabled" in saved && "autoNext" in saved && "courseKey" in saved && typeof saved.enabled === "boolean" && typeof saved.autoNext === "boolean" && typeof saved.courseKey === "string") {
        const until = "resumeUntil" in saved && typeof saved.resumeUntil === "number" ? saved.resumeUntil : 0;
        state = {
          enabled: saved.enabled && until > Date.now() && until <= Date.now() + 3e4,
          autoNext: saved.autoNext,
          courseKey: saved.courseKey,
          playbackRate: "playbackRate" in saved && validRate(saved.playbackRate) ? saved.playbackRate : 1
        };
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
    function validRate(value) {
      return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 4;
    }
    function isVisible(element) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return element.getClientRects().length > 0 && style?.visibility !== "hidden" && style?.display !== "none" && !element.closest("[hidden], [aria-hidden='true']");
    }
    function getDocuments() {
      const documents = [document];
      for (let index = 0; index < documents.length; index++) {
        for (const frame of documents[index].querySelectorAll("iframe")) {
          if (!isVisible(frame)) continue;
          try {
            const child = frame.contentDocument;
            if (child && child.location.origin === location.origin && !documents.includes(child)) documents.push(child);
          } catch {
          }
        }
      }
      return documents;
    }
    function getVideos() {
      const videos = getDocuments().flatMap((doc) => Array.from(doc.querySelectorAll("video")));
      for (const previous of observedVideos) {
        if (!videos.includes(previous)) {
          visibilityObserver?.unobserve(previous);
          observedVideos.delete(previous);
          intersectingVideos.delete(previous);
        }
      }
      return videos.filter(isVisible).filter((video) => {
        if (!visibilityObserver) return true;
        if (!observedVideos.has(video)) {
          observedVideos.add(video);
          visibilityObserver.observe(video);
        }
        return state.enabled && video === currentVideo || intersectingVideos.has(video);
      }).sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight);
    }
    function findVideo() {
      const videos = getVideos();
      return (currentVideo && videos.includes(currentVideo) ? currentVideo : videos[0]) ?? null;
    }
    function getCourseKey(video) {
      const urls = [new URL(location.href), new URL(video.ownerDocument.URL)];
      for (const url of urls) {
        if (platform === "chaoxing") {
          const courseId = url.searchParams.get("courseId") || url.searchParams.get("courseid");
          const classId = url.searchParams.get("clazzid");
          if (courseId && classId) return `${url.origin}/course/${courseId}/class/${classId}`;
        }
        const classroomId = url.searchParams.get("classroom_id") || url.pathname.match(/\/studentLog\/(\d+)/)?.[1];
        if (classroomId) return `${url.origin}/classroom/${classroomId}`;
        const coursePath = url.pathname.match(/^\/pro\/lms\/[^/]+\/[^/]+/) || url.pathname.match(/^\/ai-workspace\/lms-graph\/.*?(?=\/video\/)/);
        if (coursePath) return `${url.origin}${coursePath[0]}`;
      }
      return "";
    }
    function stop(reason, pauseVideo = false) {
      playRequest++;
      state.enabled = false;
      resumeUntil = 0;
      window.clearTimeout(navigationTimer);
      navigationTimer = void 0;
      message = reason;
      saveState();
      if (pauseVideo && currentVideo?.isConnected && !currentVideo.paused) currentVideo.pause();
    }
    function formatTime(seconds) {
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
      return {
        platform,
        enabled: state.enabled,
        autoNext: state.autoNext,
        message,
        playbackRate: state.enabled && video ? video.playbackRate : state.playbackRate,
        hasVideo: !!video,
        videoArea: video ? video.clientWidth * video.clientHeight : 0
      };
    }
    function openNext(item, video) {
      message = "视频已结束，正在打开下一节。";
      missingSince = Date.now();
      resumeUntil = state.courseKey ? Date.now() + 3e4 : 0;
      saveState();
      item.click();
      navigationTimer = window.setTimeout(() => {
        if (state.enabled && currentVideo === video && video.ended) stop("下一节未能打开，请手动选择视频。");
      }, 15e3);
    }
    function nextChaoxingVideo(video) {
      const pendingVideo = getVideos().find((item) => item !== video && !item.ended && !item.ownerDocument.defaultView?.frameElement?.closest(".ans-job-finished"));
      if (pendingVideo) {
        bindVideo(pendingVideo);
        void playVideo(pendingVideo);
        return;
      }
      const unfinishedTask = getDocuments().some((doc) => Array.from(doc.querySelectorAll(".ans-job-icon")).some((item) => isVisible(item) && !item.classList.contains("ans-job-icon-clear")));
      if (unfinishedTask) {
        stop("本节还有未完成的任务，请在页面中确认后继续。");
        return;
      }
      const chapters = Array.from(document.querySelectorAll("#coursetree h4"));
      const activeIndex = chapters.findIndex((item) => item.classList.contains("currents"));
      const taskCount = chapters[activeIndex]?.querySelector(".jobCount")?.textContent?.trim() || "";
      if (/^\d+$/.test(taskCount) && Number(taskCount) > 0) {
        stop("学习通目录仍显示未完成任务，请确认本节任务后继续。");
        return;
      }
      const nextButton = document.querySelector("#right1");
      if (activeIndex < 0 || activeIndex >= chapters.length - 1 || !nextButton || !isVisible(nextButton) || nextButton.hasAttribute("disabled") || nextButton.getAttribute("aria-disabled") === "true") {
        stop("当前目录中没有可切换的下一节，请手动选择章节。");
        return;
      }
      openNext(nextButton, video);
    }
    function nextVideo(video) {
      if (!state.enabled || !state.autoNext || !video.isConnected || !video.ended || currentVideo !== video) return;
      if (platform === "chaoxing") {
        nextChaoxingVideo(video);
        return;
      }
      for (const doc of [video.ownerDocument, ...getDocuments()]) {
        const activeItems = doc.querySelectorAll(".leaf-item.is-active");
        if (activeItems.length !== 1) continue;
        const items = Array.from(activeItems[0].parentElement?.querySelectorAll(".leaf-item") || []);
        const activeIndex = items.indexOf(activeItems[0]);
        if (activeIndex < 0) continue;
        for (const item of items.slice(activeIndex + 1)) {
          const kind = item.querySelector(".leaf-item-tag")?.textContent?.trim();
          if (kind !== "视频" || !isVisible(item) || item.classList.contains("is-disabled") || item.getAttribute("aria-disabled") === "true") {
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
    async function playVideo(video) {
      const request = ++playRequest;
      if (video.ended) {
        stop("当前视频已播放完，请选择下一节。");
        return;
      }
      try {
        video.playbackRate = state.playbackRate;
        await video.play();
        if ((!state.enabled || currentVideo !== video) && video.isConnected) video.pause();
      } catch {
        if (request === playRequest && state.enabled && currentVideo === video) {
          stop("播放未启动，请先在网页播放器中点击播放，再点开始/继续。");
        }
      }
    }
    function bindVideo(video) {
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
        navigationTimer = window.setTimeout(() => nextVideo(video), 3e3);
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
        if (Date.now() - missingSince > 15e3) stop("当前页面未找到视频，请打开视频学习页后继续。");
        return;
      }
      if (getCourseKey(video) !== state.courseKey) {
        stop("课程页面已切换，请手动开始新课程。");
        return;
      }
      missingSince = 0;
      const source = video.currentSrc || video.src;
      if (!state.courseKey && (location.href !== startedPage || currentVideo && currentVideo !== video || lastSource && source && lastSource !== source)) {
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
    function handleMessage(request) {
      if ((request.action === "start" || request.action === "setAutoNext" || request.action === "setPlaybackRate") && request.platform && request.platform !== platform) {
        return { ...getStatus(), message: `当前页面属于${platformName}，请重新打开扩展以识别平台。` };
      }
      if (request.action === "pause") stop("已暂停。", true);
      if (request.action === "setPlaybackRate") {
        if (!validRate(request.playbackRate)) return { ...getStatus(), message: "请选择 0.5–4 倍速。" };
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
    let quizSnapshot = /* @__PURE__ */ new Map();
    let submitAbort = null;
    let submitJobId = null;
    function handleQuiz(request) {
      if (request.action === "getQuiz") {
        quizSnapshot = /* @__PURE__ */ new Map();
        const questions = [];
        let skipped = 0;
        const reasons = [];
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
      if (request.action === "submitQuiz") return submitSnapshot(request.questions, typeof request.jobId === "string" ? request.jobId : null);
      if (!Array.isArray(request.answers) || !Array.isArray(request.questions)) {
        return { applied: 0, skipped: 0, errors: ["题目快照或答案无效，请重新识别。"] };
      }
      const result = { applied: 0, skipped: 0, errors: [] };
      const visibleDocuments = getDocuments();
      for (const answer of request.answers) {
        const original = answer && typeof answer.id === "string" ? quizSnapshot.get(answer.id) : null;
        const expected = request.questions.find((q) => q?.id === answer?.id);
        if (!original || !expected || !visibleDocuments.includes(original.doc) || JSON.stringify({ ...original.question, id: expected.id }) !== JSON.stringify(expected)) {
          result.skipped++;
          result.errors.push("题目页面已变化，已跳过对应答案。");
          continue;
        }
        const applied = applyAnswers(original.doc, [{ ...answer, id: original.question.id }], [original.question]);
        result.applied += applied.applied;
        result.skipped += applied.skipped;
        result.errors.push(...applied.errors);
      }
      return result;
    }
    async function submitSnapshot(expected, jobId) {
      submitAbort?.abort();
      submitAbort = new AbortController();
      submitJobId = jobId;
      const signal = submitAbort.signal;
      if (!Array.isArray(expected) || !expected.length || expected.length !== quizSnapshot.size) {
        return { submitted: false, message: "题目识别不完整，未自动提交。" };
      }
      const groups = /* @__PURE__ */ new Map();
      for (const item of expected) {
        const original = quizSnapshot.get(item?.id);
        if (!original || !getDocuments().includes(original.doc) || JSON.stringify({ ...original.question, id: item.id }) !== JSON.stringify(item)) {
          return { submitted: false, message: "题目页面已变化，未自动提交。" };
        }
        const list = groups.get(original.doc) || [];
        list.push(original.question);
        groups.set(original.doc, list);
      }
      if (groups.size !== 1) return { submitted: false, message: "检测到多个独立答题页面，请分别打开后提交。" };
      const [doc, questions] = [...groups][0];
      return submitQuiz(doc, questions, signal);
    }
    window.setInterval(updateVideo, 1e3);
    updateVideo();
    return {
      handle(request) {
        try {
          if (request.action === "cancelQuiz") {
            if (typeof request.jobId === "string" && request.jobId !== submitJobId) {
              return { cancelled: false, message: "该任务已经结束，当前提交未受影响。" };
            }
            submitAbort?.abort();
            return { cancelled: true, message: "已停止后续提交确认，已发出的提交不能撤销。" };
          }
          if (request.action === "getQuiz" || request.action === "applyAnswers" || request.action === "submitQuiz") return handleQuiz(request);
          if (!["getStatus", "start", "pause", "setAutoNext", "setPlaybackRate"].includes(String(request.action))) return;
          return handleMessage(request);
        } catch {
          stop("页面操作失败，请刷新课程页面后重试。");
          return { ...getStatus(), error: "页面操作失败，请刷新课程页面后重试。" };
        }
      }
    };
  }

  // ui.ts
  var rates = [0.5, 1, 1.25, 1.5, 2, 3, 4];
  function errorMessage(value) {
    return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : null;
  }
  function isStatus(value) {
    if (!value || typeof value !== "object") return false;
    const s = value;
    return (s.platform === "rain" || s.platform === "chaoxing") && typeof s.enabled === "boolean" && typeof s.autoNext === "boolean" && typeof s.message === "string";
  }
  function mountPanel(transport) {
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
        <div class="settings-row"><label class="check"><input id="next" type="checkbox" disabled>自动下一节</label><label>倍速 <select id="rate" aria-label="视频播放倍速" disabled>${rates.map((rate2) => `<option value="${rate2}">${rate2}×</option>`).join("")}</select></label></div>
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
    const element = (id) => shadow.getElementById(id);
    const shell = element("shell");
    const launcher = element("launcher");
    const start = element("start");
    const pause = element("pause");
    const autoNext = element("next");
    const rate = element("rate");
    const quiz = element("quiz");
    const cancel = element("cancel");
    const statusText = element("status");
    const quizText = element("quizStatus");
    let state = null;
    let quizState = { status: "idle" };
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
    async function call(message) {
      let timer;
      try {
        return await Promise.race([transport(message), new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("连接超时，请刷新课程页后重试。")), 1e4);
        })]);
      } finally {
        window.clearTimeout(timer);
      }
    }
    async function command(action, extra = {}) {
      const isPoll = action === "getStatus";
      if (busy || isPoll && polling) return;
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
    function renderQuiz(response) {
      quizState = response;
      const progress = typeof response.total === "number" && typeof response.completed === "number" ? `（${response.completed}/${response.total}）` : "";
      if (response.message) quizText.textContent = `${response.message}${progress}`;
      else if (response.status === "running") quizText.textContent = `正在分析本页题目…${progress}`;
      else if (response.status === "done") quizText.textContent = "本次处理完成，请查看课程页提交状态。";
      else if (response.status === "cancelled") quizText.textContent = "已停止做题。";
      if (Array.isArray(response.results)) {
        const list = element("resultList");
        list.replaceChildren();
        for (const result of response.results) {
          const row = document.createElement("li");
          const answer = Array.isArray(result.answer) ? result.answer.join("、") : String(result.answer ?? "未提供答案");
          row.textContent = `${answer}${result.explanation ? `
${result.explanation}` : ""}`;
          list.append(row);
        }
        element("results").hidden = response.results.length === 0;
      }
      controls();
    }
    async function quizCommand(action) {
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
          renderQuiz(response);
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
      if (!shell.hidden) {
        void command("getStatus");
        void quizCommand("quizStatus");
      }
    }
    launcher.addEventListener("click", toggle);
    element("collapse").addEventListener("click", () => {
      toggle();
      launcher.focus();
    });
    start.addEventListener("click", () => {
      void command("start");
    });
    pause.addEventListener("click", () => {
      void command("pause");
    });
    autoNext.addEventListener("change", () => {
      void command("setAutoNext", { autoNext: autoNext.checked });
    });
    rate.addEventListener("change", () => {
      void command("setPlaybackRate", { playbackRate: Number(rate.value) });
    });
    quiz.addEventListener("click", () => {
      void quizCommand("quizRun");
    });
    cancel.addEventListener("click", () => {
      void quizCommand("quizCancel");
    });
    element("settings").addEventListener("click", () => {
      void call({ action: "openOptions" }).then((response) => {
        const error = errorMessage(response);
        if (error) quizText.textContent = error;
      }, () => {
        quizText.textContent = "设置未能打开，请从扩展菜单进入 API 设置。";
      });
    });
    const poll = () => {
      if (!host.isConnected) {
        window.clearInterval(interval);
        return;
      }
      if (document.hidden) return;
      if (!shell.hidden) void command("getStatus");
      if (quizState.status === "running" || !shell.hidden) void quizCommand("quizStatus");
    };
    let interval = window.setInterval(poll, 1500);
    window.addEventListener("pagehide", () => window.clearInterval(interval));
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && host.isConnected) {
        window.clearInterval(interval);
        interval = window.setInterval(poll, 1500);
        poll();
      }
    });
    void command("getStatus");
    void quizCommand("quizStatus");
  }

  // content.ts
  var controller = bootContent();
  if (controller) {
    chrome.runtime.onMessage.addListener((request, _sender, respond) => {
      if (!request || typeof request !== "object" || !("type" in request) || request.type !== "courseHelper") return;
      const result = controller.handle(request);
      if (result instanceof Promise) {
        void result.then(respond, () => respond({ error: "页面操作未完成，请检查课程页。" }));
        return true;
      }
      if (result !== void 0) respond(result);
    });
  }
  if (window === window.top) {
    mountPanel((message) => chrome.runtime.sendMessage({ ...message, type: "courseHelperPanel" }));
  }
})();
