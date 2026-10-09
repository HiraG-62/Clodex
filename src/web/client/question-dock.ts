import type { PendingQuestion } from "../../protocol/questions.js";
import { nextUnanswered, questionAnswers } from "./question-flow.js";
import type { ClientContext } from "./store.js";

export function createQuestionDock(ctx: ClientContext) {
  // ---- 質問欄（入力欄の上。未回答の質問を 1 問ずつ出す）----
  const questionDock = ctx.$("#question-dock");
  let dockId: string | undefined;
  let dockCollapsed = false;
  let dockSubmitting = false;
  const draftOf = (pending: PendingQuestion) => {
    const saved = ctx.store.questionDrafts.get(pending.id);
    if (saved) return saved;
    const draft = { selected: pending.questions.map(() => new Set<number>()), other: pending.questions.map(() => ""), step: 0 };
    ctx.store.questionDrafts.set(pending.id, draft);
    return draft;
  };
  const renderQuestionDock = (force = false) => {
    const pending = ctx.store.state?.questions ?? [];
    for (const id of ctx.store.questionDrafts.keys()) if (!pending.some(entry => entry.id === id)) ctx.store.questionDrafts.delete(id);
    const current = pending[0];
    questionDock.hidden = !current;
    if (!current) {
      dockId = undefined;
      questionDock.replaceChildren();
      return;
    }
    const more = pending.length - 1;
    if (!force && dockId === current.id) {
      const moreLabel = questionDock.querySelector<HTMLElement>(".question-more");
      if (moreLabel) {
        moreLabel.hidden = more === 0;
        moreLabel.textContent = ctx.t("web.question.more", { count: more });
      }
      return;
    }
    if (dockId !== current.id) dockSubmitting = false;
    dockId = current.id;
    const draft = draftOf(current);
    const total = current.questions.length;
    const index = draft.step;
    const question = current.questions[index]!;
    questionDock.className = `question-dock ${current.agent}`;
    questionDock.classList.toggle("collapsed", dockCollapsed);
    const go = (step: number) => {
      draft.step = step;
      renderQuestionDock(true);
    };

    const header = ctx.el("button", "question-dock-head") as HTMLButtonElement;
    header.type = "button";
    header.setAttribute("aria-expanded", String(!dockCollapsed));
    const moreLabel = ctx.el("span", "muted small question-more", ctx.t("web.question.more", { count: more }));
    moreLabel.hidden = more === 0;
    header.append(
      ctx.icon("question"),
      ctx.el("b", `c-${current.agent}`, ctx.AGENTS[current.agent].name),
      ctx.el("span", "", ctx.t("web.question.title")),
      ctx.el("span", "mono muted question-step", `${index + 1}/${total}`),
      moreLabel,
      ctx.icon("chevron-down"),
    );
    header.addEventListener("click", () => {
      dockCollapsed = !dockCollapsed;
      renderQuestionDock(true);
    });
    if (dockCollapsed) return void questionDock.replaceChildren(header);

    const body = ctx.el("div", "question-dock-body");
    const dots = ctx.el("div", "question-dots");
    const answered = (step: number) => Boolean(draft.selected[step]?.size || draft.other[step]?.trim());
    const refreshDots = () =>
      [...dots.children].forEach((dot, step) => {
        dot.classList.toggle("answered", answered(step));
      });
    if (total > 1) {
      current.questions.forEach((entry, step) => {
        const dot = ctx.el("button", step === index ? "question-dot current" : "question-dot") as HTMLButtonElement;
        dot.type = "button";
        dot.setAttribute("aria-label", `${step + 1}/${total} ${entry.header ?? entry.question}`);
        dot.addEventListener("click", () => go(step));
        dots.append(dot);
      });
    }
    const field = ctx.el("div", "question-field");
    if (question.header) field.append(ctx.el("span", "kind", question.header));
    field.append(ctx.el("p", "question-text", question.question));
    const options = ctx.el("div", "question-options");
    const other = ctx.el("input", "question-other") as HTMLInputElement;
    other.type = "text";
    other.placeholder = ctx.t("web.question.other");
    other.setAttribute("aria-label", ctx.t("web.question.other"));
    other.value = draft.other[index] ?? "";
    const prev = ctx.el("button", "btn question-prev", ctx.t("web.question.prev")) as HTMLButtonElement;
    prev.type = "button";
    prev.disabled = index === 0;
    prev.addEventListener("click", () => go(index - 1));
    const next = ctx.el("button", "btn question-next", ctx.t("web.question.next")) as HTMLButtonElement;
    next.type = "button";
    next.hidden = index === total - 1;
    next.addEventListener("click", () => go(index + 1));
    const submit = ctx.el("button", "question-submit", ctx.t("web.question.answer")) as HTMLButtonElement;
    submit.type = "button";
    const buttons: HTMLButtonElement[] = [];
    const refresh = () => {
      buttons.forEach((button, optionIndex) => {
        const selected = draft.selected[index]!.has(optionIndex);
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
      refreshDots();
      submit.disabled = dockSubmitting || !answered(index) || nextUnanswered(current.questions, draft, index) !== undefined;
    };
    const advance = () => {
      const target = nextUnanswered(current.questions, draft, index);
      if (target === undefined) return refresh();
      go(target);
    };
    question.options.forEach((option, optionIndex) => {
      const button = ctx.el("button", "question-option") as HTMLButtonElement;
      button.type = "button";
      const label = ctx.el("span", "question-label", option.label);
      if (option.recommended) {
        const mark = ctx.el("span", "question-recommended");
        mark.title = ctx.t("web.question.recommended");
        mark.setAttribute("aria-label", ctx.t("web.question.recommended"));
        mark.append(ctx.icon("star"));
        label.append(mark);
      }
      button.append(label);
      if (option.description) button.append(ctx.el("small", "muted", option.description));
      button.addEventListener("click", () => {
        const selected = draft.selected[index]!;
        const wasSelected = selected.has(optionIndex);
        if (!question.multiSelect) {
          selected.clear();
          draft.other[index] = "";
          other.value = "";
        }
        if (wasSelected) selected.delete(optionIndex);
        else selected.add(optionIndex);
        if (!question.multiSelect && !wasSelected) return advance();
        refresh();
      });
      buttons.push(button);
      options.append(button);
    });
    other.addEventListener("input", () => {
      draft.other[index] = other.value;
      if (!question.multiSelect && other.value.trim()) draft.selected[index]!.clear();
      refresh();
    });
    other.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || !other.value.trim()) return;
      event.preventDefault();
      advance();
    });
    submit.addEventListener("click", async () => {
      dockSubmitting = true;
      refresh();
      const ok = await ctx.send(`/answer ${current.id} ${JSON.stringify(questionAnswers(current.questions, draft))}`, submit);
      if (ok) return;
      dockSubmitting = false;
      refresh();
    });
    const nav = ctx.el("div", "question-nav");
    nav.append(prev, next, submit);
    field.append(options, other);
    ctx.appendImagePreviews(field, [question.question, ...question.options.map(option => option.description ?? "")].join("\n"), current.id);
    body.append(...(total > 1 ? [dots] : []), field, nav);
    questionDock.replaceChildren(header, body);
    refresh();
  };
  return { renderQuestionDock };
}
