/** DOM adapters only: no API keys, requests, or direct platform API calls. */
export type QuizQuestion = {
  id: string;
  type: "single" | "multiple" | "boolean" | "text";
  text: string;
  options: Array<{ id: string; text: string }>;
};
export type QuizAnswer = { id: string; optionIds?: string[]; text?: string };
export type QuizApplyResult = { applied: number; skipped: number; errors: string[] };
export type QuizSubmitResult = { submitted: boolean; confirmed: boolean; message: string };
type TextControl = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type OptionBinding = { id: string; text: string; target: HTMLElement; input: HTMLInputElement | null };
type Binding = { question: QuizQuestion; root: HTMLElement; options: OptionBinding[]; fields: TextControl[] };

// Selector evidence (adapter design is original):
// https://github.com/ArtLjn/chaoxing-qa (questionLi, mark_name, answerBg, Zy_TItle)
// https://greasyfork.org/en/scripts/443052-answertip/code (TiMu, subject-item, problem-body)
const ROOTS = ".TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item,.item-body,div[id^='question'],fieldset";
const TITLE_SELECTORS = [".mark_name", ".Zy_TItle", ".question-title", ".question-stem", ".subject-title", ".problem-body", "legend", ".item-body", "h4", "h3"];
const OPTION_WRAPPERS = ".answerBg,.Zy_ulTop > li,.question-options > li,.options > li,.item-body ul > li,.el-radio,.el-checkbox,[role=radio],[role=checkbox]";
const TEXT_FIELDS = 'textarea,input[type=text],input:not([type]),[contenteditable="true"]';
const MAX_QUESTIONS = 100;
const MAX_TEXT = 12000;
const appliedSnapshots = new WeakMap<Document, Map<string, QuizAnswer>>();

function normalize(text: string | null | undefined) {
  return (text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function visible(element: Element) {
  if (element.closest('[hidden],[aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    const style = view?.getComputedStyle(cursor);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return element.getClientRects().length > 0;
}

function blocked(element: Element) {
  return element.matches(":disabled") || element.hasAttribute("readonly")
    || !!element.closest('[aria-disabled="true"],[aria-readonly="true"],.is-disabled,fieldset[disabled]');
}

function plainText(element: Element, removeOptions = false) {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,[hidden],[aria-hidden="true"],input,textarea,button,.answer-analysis,.analysis,.answer-result,.correct-answer,.answer-feedback').forEach(node => node.remove());
  if (removeOptions) clone.querySelectorAll(`${OPTION_WRAPPERS},label,ul,ol,[contenteditable]`).forEach(node => node.remove());
  return normalize(clone.textContent);
}

function unsupportedContent(element: Element) {
  // Encrypted-font text is not the text the student sees. Image-only questions
  // also need a separate image-aware adapter, not guessed text answers.
  return element.matches(".font-cxsecret,.font-cxsecret2")
    || !!element.querySelector(".font-cxsecret,.font-cxsecret2,canvas,img:not([aria-hidden='true']):not([role='presentation'])");
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

function optionText(target: Element, input: HTMLInputElement | null) {
  const content = target.querySelector(".answer_p,.option-content,.el-radio__label,.el-checkbox__label,a.after");
  let value = content ? plainText(content) : plainText(target);
  if (!value && input) value = normalize(input.getAttribute("aria-label"));
  return value.replace(/^[A-Z][.、．:：)）]\s*/, "").trim();
}

function findOptions(root: HTMLElement): OptionBinding[] {
  const targets: Array<{ target: HTMLElement; input: HTMLInputElement | null }> = [];
  const native = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]'));
  for (const input of native) {
    let target = input.closest<HTMLElement>(".answerBg,.Zy_ulTop > li,.question-options > li,.options > li,.el-radio,.el-checkbox")
      || input.closest<HTMLElement>("label") || input.closest<HTMLElement>("[role=radio],[role=checkbox]");
    if (!target) target = Array.from(input.labels || []).find(label => root.contains(label)) || input;
    if (root.contains(target) && visible(target) && !blocked(target) && !blocked(input)) targets.push({ target, input });
  }
  for (const target of root.querySelectorAll<HTMLElement>(OPTION_WRAPPERS)) {
    if (!visible(target) || blocked(target)) continue;
    if (targets.some(existing => existing.target === target || existing.target.contains(target) || target.contains(existing.target))) continue;
    // Avoid disabled native controls hidden inside an otherwise visible label.
    if (target.querySelector('input:disabled,input[readonly]')) continue;
    targets.push({ target, input: target.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"]') });
  }
  // Native inputs and custom controls can coexist; keep actual DOM order.
  targets.sort((a, b) => a.target.compareDocumentPosition(b.target) & 2 ? 1 : -1);
  const used = new Set<string>();
  return targets.map(({ target, input }, index) => {
    const marker = target.querySelector(".num_option[data]")?.getAttribute("data")
      || target.getAttribute("data-option-id") || input?.value;
    let id = marker && /^[A-Za-z0-9_-]{1,32}$/.test(marker) && marker !== "on" ? marker : String.fromCharCode(65 + index);
    if (used.has(id)) id = `option-${index + 1}`;
    used.add(id);
    return { id, text: optionText(target, input), target, input };
  });
}

function findFields(root: HTMLElement): TextControl[] {
  const fields = Array.from(root.querySelectorAll<TextControl>(TEXT_FIELDS))
    .filter(field => visible(field) && !blocked(field) && !field.closest('.answer-analysis,.analysis,.answer-feedback'));
  for (const iframe of root.querySelectorAll<HTMLIFrameElement>("iframe")) {
    if (!visible(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true") && !blocked(body)) fields.push(body);
    } catch { /* Do not cross the browser's origin boundary. */ }
  }
  return fields.filter(field => !fields.some(other => other !== field && other.contains(field)));
}

function inferType(root: HTMLElement, text: string, options: OptionBinding[], fields: TextControl[]): QuizQuestion["type"] | null {
  const hint = `${root.getAttribute("data-question-type") || ""} ${root.querySelector(".subject-type,.question-type,.item-type,.type")?.textContent || ""} ${text}`;
  if (options.length >= 2) {
    if (/多选|multiple/i.test(hint) || options.some(option => option.input?.type === "checkbox" || option.target.getAttribute("role") === "checkbox" || option.target.classList.contains("el-checkbox"))) return "multiple";
    if (/判断|boolean|true\s*\/\s*false/i.test(hint)
      || (options.length === 2 && options.every(option => /^(正确|错误|对|错|是|否|true|false|√|×)$/i.test(option.text)))) return "boolean";
    if (/单选|single/i.test(hint) || options.every(option => option.input?.type === "radio" || option.target.getAttribute("role") === "radio" || option.target.classList.contains("el-radio"))) return "single";
    return null;
  }
  if (fields.length && (/填空|简答|问答|论述|text|填入|回答/i.test(hint) || root.tagName === "FIELDSET")) return "text";
  return null;
}

function collect(doc: Document): { bindings: Binding[]; skipped: number; reasons: string[] } {
  const bindings: Binding[] = [];
  const reasons: string[] = [];
  const roots = Array.from(doc.querySelectorAll<HTMLElement>(ROOTS)).filter(visible).filter(root => {
    // Generic "question..." IDs and item-body classes also occur on title/option
    // fragments; only accept them when they contain an actual question heading.
    if (root.matches(".TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item,fieldset")) return true;
    return !!root.querySelector(".Zy_TItle,.mark_name,.question-stem,.problem-body,h4");
  });
  // Nested marker classes describe the same question. The innermost question
  // container owns its controls; outer groups must not become duplicate items.
  const leaves = roots.filter(root => !roots.some(other => other !== root && root.contains(other)));
  let skipped = 0;
  for (const [index, root] of leaves.entries()) {
    if (bindings.length >= MAX_QUESTIONS) { skipped++; continue; }
    if (blocked(root) || unsupportedContent(root) || root.querySelector('input[type="radio"]:disabled,input[type="checkbox"]:disabled,[role="radio"][aria-disabled="true"],[role="checkbox"][aria-disabled="true"]')) {
      skipped++;
      reasons.push("图片、加密字体或不可编辑题目需要手动处理。");
      continue;
    }
    const title = TITLE_SELECTORS.map(selector => root.querySelector(selector)).find(Boolean);
    let text = title ? plainText(title, true) : plainText(root, true);
    const options = findOptions(root);
    const fields = findFields(root);
    const type = inferType(root, text, options, fields);
    if (!type || !text || text.length > MAX_TEXT || (type !== "text" && (options.length > 26 || options.some(option => !option.text || option.text.length > MAX_TEXT)))) {
      skipped++;
      reasons.push("题型、题干或选项无法可靠识别，已跳过。");
      continue;
    }
    if (type === "text" && fields.length > 1) text += `（共有 ${fields.length} 个答题框，请按顺序用 | 分隔各空答案。）`;
    const serialized = { type, text, options: type === "text" ? [] : options.map(({ id, text: label }) => ({ id, text: label })) };
    const route = `${doc.location?.origin || ""}${doc.location?.pathname || ""}`;
    const id = `q-${index + 1}-${hash(route + JSON.stringify(serialized))}`;
    bindings.push({ question: { id, ...serialized }, root, options: type === "text" ? [] : options, fields });
  }
  return { bindings, skipped, reasons: [...new Set(reasons)] };
}

/** Read only visible, editable questions with unambiguous controls. */
export function scanQuiz(doc: Document): QuizQuestion[] {
  return collect(doc).bindings.map(binding => binding.question);
}

/** Extra diagnostics for user-facing "nothing detected" and partial-page states. */
export function scanQuizDetailed(doc: Document): { questions: QuizQuestion[]; skipped: number; reasons: string[] } {
  const result = collect(doc);
  return { questions: result.bindings.map(binding => binding.question), skipped: result.skipped, reasons: result.reasons };
}

function checked(option: OptionBinding) {
  if (option.input) return option.input.checked;
  const aria = option.target.getAttribute("aria-checked") || option.target.querySelector("[aria-checked]")?.getAttribute("aria-checked");
  if (aria) return aria === "true";
  return option.target.matches(".is-checked,.checked,.active,.Hover,.check_answer,.answer_checked")
    || !!option.target.querySelector(".is-checked,.checked,.Hover");
}

function setText(field: TextControl, value: string) {
  const view = field.ownerDocument.defaultView;
  if (!view) throw new Error("答题框已离开当前页面。");
  if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
    const prototype = field.tagName === "INPUT" ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  } else field.textContent = value;
  field.dispatchEvent(new view.Event("input", { bubbles: true }));
  field.dispatchEvent(new view.Event("change", { bubbles: true }));
}

function fieldValue(field: TextControl) {
  return field.tagName === "INPUT" || field.tagName === "TEXTAREA"
    ? (field as HTMLInputElement | HTMLTextAreaElement).value : field.textContent || "";
}

function answerMatches(binding: Binding, answer: QuizAnswer) {
  if (binding.question.type === "text") {
    if (typeof answer.text !== "string") return false;
    const values = binding.fields.length > 1 ? answer.text.split("|").map(value => value.trim()) : [answer.text];
    return values.length === binding.fields.length && binding.fields.every((field, index) => fieldValue(field) === values[index]);
  }
  const wanted = new Set(answer.optionIds || []);
  return wanted.size > 0 && binding.options.every(option => checked(option) === wanted.has(option.id));
}

/** Fill answers through normal DOM interactions. Never clicks Submit/Next. */
export function applyAnswers(doc: Document, answers: QuizAnswer[], expected?: QuizQuestion[]): QuizApplyResult {
  const result: QuizApplyResult = { applied: 0, skipped: 0, errors: [] };
  const bindings = new Map(collect(doc).bindings.map(binding => [binding.question.id, binding]));
  const snapshots = expected ? new Map(expected.map(question => [question.id, question])) : null;
  const seen = new Set<string>();
  for (const answer of answers) {
    try {
      if (!answer || typeof answer.id !== "string" || seen.has(answer.id)) throw new Error("答案缺少题目编号或存在重复编号。");
      seen.add(answer.id);
      const binding = bindings.get(answer.id);
      if (!binding || !binding.root.isConnected || !visible(binding.root)) throw new Error("题目已变化或离开页面，请重新识别。");
      if (snapshots && JSON.stringify(snapshots.get(answer.id)) !== JSON.stringify(binding.question)) throw new Error("题目内容已变化，未填写旧答案。");
      if (binding.question.type === "text") {
        if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > MAX_TEXT) throw new Error("文本答案为空或过长。");
        const values = binding.fields.length > 1 ? answer.text.split("|").map(value => value.trim()) : [answer.text];
        if (values.length !== binding.fields.length || values.some(value => !value)) throw new Error("答案数量与填空数量不一致。");
        if (binding.fields.some(blocked)) throw new Error("答题框不可编辑。");
        binding.fields.forEach((field, index) => setText(field, values[index]));
      } else {
        if (!Array.isArray(answer.optionIds) || !answer.optionIds.length || answer.optionIds.some(id => typeof id !== "string")) throw new Error("选择题答案缺少有效选项。");
        const wanted = new Set(answer.optionIds);
        if (wanted.size !== answer.optionIds.length || (binding.question.type !== "multiple" && wanted.size !== 1)) throw new Error("选项数量与题型不符。");
        if ([...wanted].some(id => !binding.options.some(option => option.id === id))) throw new Error("答案包含页面中不存在的选项。");
        if (binding.options.some(option => blocked(option.target) || (option.input && blocked(option.input)))) throw new Error("选项当前不可编辑。");
        for (const option of binding.options) {
          const select = wanted.has(option.id);
          if (select === checked(option) || (!select && binding.question.type !== "multiple")) continue;
          // Click native controls directly so browser input/change events fire.
          // Custom Vue/ARIA wrappers receive their own normal click handler.
          (option.input || option.target).click();
        }
      }
      if (!answerMatches(binding, answer)) throw new Error("页面未确认答案已填入，请检查控件状态后重试。");
      if (!appliedSnapshots.has(doc)) appliedSnapshots.set(doc, new Map());
      appliedSnapshots.get(doc)!.set(answer.id, { id: answer.id, optionIds: answer.optionIds ? [...answer.optionIds] : undefined, text: answer.text });
      result.applied++;
    } catch (error) {
      result.skipped++;
      result.errors.push(error instanceof Error ? error.message : "此题填写失败，请手动检查。");
    }
  }
  result.errors = [...new Set(result.errors)];
  return result;
}

const SUBMIT_LABEL = /^(提交|提交答案|提交作业|交卷|提交试卷|确认交卷)$/;
const CONFIRM_LABEL = /^(确定|确认|确认提交|确定提交|提交|交卷|确认交卷|确定交卷)$/;
const BUTTONS = 'button,input[type="submit"],input[type="button"],a[role="button"],a[onclick],a[href^="javascript:"],[role="button"],.submitBtn,.submit-btn,#submitWork,#submitTest,.jb_btn,.jb_btn_bg';
const DIALOGS = '[role="dialog"],dialog[open],.el-message-box,.layui-layer-dialog,.ui-dialog,.artDialog';

function buttonLabel(element: HTMLElement) {
  const value = element.tagName === "INPUT" ? (element as HTMLInputElement).value : element.textContent;
  return normalize(value || element.getAttribute("aria-label")).replace(/\s/g, "");
}

function buttonCandidates(scope: ParentNode, labels: RegExp) {
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(BUTTONS))
    .filter(element => visible(element) && !blocked(element) && labels.test(buttonLabel(element)));
  // An ARIA label may be nested in an actual button. Click the actual outer
  // control once, rather than treating the same action as two candidates.
  return elements.filter(element => !elements.some(other => other !== element && other.contains(element)));
}

const OUTCOME_NODES = '.submit-success,.success-message,.el-message--success,[data-submit-success="true"],[role="status"],h1,h2,.el-message--error,.error-message,[role="alert"]';

function submitOutcome(doc: Document, before: Map<Element, string>): QuizSubmitResult | null {
  const successNodes = doc.querySelectorAll<HTMLElement>('.submit-success,.success-message,.el-message--success,[data-submit-success="true"],[role="status"],h1,h2');
  if (Array.from(successNodes).some(node => visible(node) && before.get(node) !== normalize(node.textContent)
    && /提交成功|交卷成功|成功提交|作业已提交|试卷已提交/.test(normalize(node.textContent)))) {
    return { submitted: true, confirmed: true, message: "页面显示提交成功。" };
  }
  const errorNodes = doc.querySelectorAll<HTMLElement>('.el-message--error,.error-message,[role="alert"]');
  const failure = Array.from(errorNodes).find(node => visible(node) && before.get(node) !== normalize(node.textContent)
    && /提交失败|交卷失败|还有.*未.*答|存在.*未.*答|请完成.*答题/.test(normalize(node.textContent)));
  if (failure) return { submitted: false, confirmed: false, message: `页面未接受提交：${normalize(failure.textContent).slice(0, 180)}` };
  return null;
}

function confirmationCandidates(doc: Document) {
  const dialogs = Array.from(doc.querySelectorAll<HTMLElement>(DIALOGS)).filter(visible)
    .filter(dialog => /提交|交卷/.test(normalize(dialog.textContent)));
  const topDialogs = dialogs.filter(dialog => !dialogs.some(other => other !== dialog && other.contains(dialog)));
  if (!topDialogs.length) return null;
  if (topDialogs.length !== 1) return [];
  return buttonCandidates(topDialogs[0], CONFIRM_LABEL);
}

function answerComplete(binding: Binding) {
  if (binding.question.type === "text") {
    return binding.fields.length > 0 && binding.fields.every(field => {
      if (blocked(field)) return false;
      return normalize(field.tagName === "INPUT" || field.tagName === "TEXTAREA"
        ? (field as HTMLInputElement | HTMLTextAreaElement).value : field.textContent).length > 0;
    });
  }
  const selected = binding.options.filter(checked);
  return binding.question.type === "multiple" ? selected.length > 0 : selected.length === 1;
}

function incompletePaper(doc: Document, expectedCount: number, form: HTMLFormElement | null): string | null {
  const controls = 'input[type="radio"],input[type="checkbox"],input[type="text"],textarea,[contenteditable="true"],[role="radio"],[role="checkbox"],.answerBg,.Zy_ulTop li,.el-radio,.el-checkbox';
  for (const root of doc.querySelectorAll<HTMLElement>(ROOTS)) {
    if (visible(root)) continue;
    const title = TITLE_SELECTORS.map(selector => root.querySelector(selector)).find(Boolean);
    const clearQuestion = root.matches('.TiMu,.singleQues,.questionLi,.mark_item,.subject-item,.question-item,.problem-item')
      || /单选|多选|判断|填空|简答|问答|论述/.test(normalize(title?.textContent))
      || !!root.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]');
    if (clearQuestion && title && normalize(title.textContent) && root.querySelector(controls)) {
      return "页面还包含未显示的题目，无法确认整卷完整，请检查其它题目后手动提交。";
    }
  }
  const paginationSelector = '.pagination,.el-pagination,.pagebar,.pageNav,.question-pagination,.exam-pagination,[aria-label*="分页"]';
  const navigation = Array.from(doc.querySelectorAll<HTMLElement>('button,a,[role="button"],input[type="button"]'))
    .filter(element => visible(element) && !blocked(element));
  if (navigation.some(element => buttonLabel(element) === "下一题"
    || (buttonLabel(element) === "下一页" && (!!form?.contains(element)
      || !!element.closest('.question-pagination,.exam-pagination') || (!form && !!element.closest(paginationSelector)))))) {
    return "当前页面仍可切换题目或试卷分页，无法确认整卷完整，请完成其它页后手动提交。";
  }
  const cards = doc.querySelectorAll<HTMLElement>('.answer-card,.answerCard,.answer-card-list,.answerSheet,.answer-sheet,.answercard,[aria-label*="答题卡"]');
  for (const card of cards) {
    if (!visible(card)) continue;
    const unfilled = card.querySelectorAll<HTMLElement>('[aria-label*="未答"],.unanswered,.not-answered,.notAnswer,.not-answer,.undone,[data-answer-status="unanswered"]');
    if (Array.from(unfilled).some(visible) || /未(?:作)?答\s*[:：]?\s*[（(]?\s*[1-9]\d*/.test(normalize(card.textContent))) {
      return "答题卡仍显示未作答题目，自动提交已停止，请先完成整卷。";
    }
  }
  const summaries = doc.querySelectorAll<HTMLElement>('.answer-card,.answerCard,.answercard,.paper-info,.test-info,.exam-info,.question-count,[aria-label*="答题卡"]');
  for (const summary of summaries) {
    if (!visible(summary)) continue;
    const total = normalize(summary.textContent).match(/共\s*(\d+)\s*(?:道)?题/);
    if (total && Number(total[1]) > expectedCount) return "试卷总题数多于当前识别题数，自动提交已停止，请检查其它页面。";
  }
  return null;
}

async function waitForPage(doc: Document, milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted || !doc.defaultView) return;
  await new Promise<void>(resolve => {
    const finish = () => { doc.defaultView?.clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = doc.defaultView!.setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Explicit opt-in submission. `submitted` means a submit action was dispatched;
 * only `confirmed` means an explicit success message was observed in the DOM.
 * Callers must not use submitted=true as proof the platform accepted the answer.
 */
export async function submitQuiz(doc: Document, expected: QuizQuestion[], signal?: AbortSignal): Promise<QuizSubmitResult> {
  const stop = (message: string): QuizSubmitResult => ({ submitted: false, confirmed: false, message });
  let dispatched = false;
  const cancellation = (): QuizSubmitResult | null => signal?.aborted
    ? { submitted: dispatched, confirmed: false, message: "已停止后续提交确认；已经发出的提交无法撤销。" } : null;
  const alreadyCancelled = cancellation();
  if (alreadyCancelled) return alreadyCancelled;
  let current = collect(doc);
  const questions = current.bindings.map(binding => binding.question);
  if (!expected.length || current.skipped || questions.length !== expected.length
    || new Set(expected.map(question => question.id)).size !== expected.length) {
    return stop("未能确认全部题目均已识别，自动提交已停止，请检查页面。");
  }
  const snapshots = new Map(expected.map(question => [question.id, question]));
  if (questions.some(question => JSON.stringify(snapshots.get(question.id)) !== JSON.stringify(question))) {
    return stop("题目或选项已经变化，自动提交已停止，请重新识别。");
  }
  // Vue and similar frameworks update custom checked classes on the next tick.
  if (!current.bindings.every(answerComplete)) await waitForPage(doc, 50, signal);
  const afterWaitCancelled = cancellation();
  if (afterWaitCancelled) return afterWaitCancelled;
  current = collect(doc);
  if (current.skipped || current.bindings.length !== expected.length
    || current.bindings.some(binding => JSON.stringify(snapshots.get(binding.question.id)) !== JSON.stringify(binding.question))) {
    return stop("题目或选项已经变化，自动提交已停止，请重新识别。");
  }
  if (!current.bindings.every(binding => binding.root.isConnected && visible(binding.root) && answerComplete(binding))) {
    return stop("仍有题目未填写，或无法确认选中状态，自动提交已停止。");
  }
  if (current.bindings.some(binding => {
    const previouslyApplied = appliedSnapshots.get(doc)?.get(binding.question.id);
    return previouslyApplied && !answerMatches(binding, previouslyApplied);
  })) return stop("填写后的答案状态已变化，自动提交已停止，请检查页面答案。");
  const before = new Map(Array.from(doc.querySelectorAll(OUTCOME_NODES)).map(node => [node, normalize(node.textContent)]));
  const forms = new Set(current.bindings.map(binding => binding.root.closest("form")));
  if (forms.size > 1) return stop("题目属于多个表单，无法确定提交范围，请手动提交。");
  const form = [...forms][0] || null;
  const scope: ParentNode = form || doc;
  const incomplete = incompletePaper(doc, expected.length, form);
  if (incomplete) return stop(incomplete);

  let confirmedDialog = false;
  const confirmOnce = (): QuizSubmitResult | null => {
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
    const candidates = buttonCandidates(scope, SUBMIT_LABEL).filter(button => !button.closest(DIALOGS));
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
