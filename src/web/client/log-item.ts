import type { MessageKey } from "../../i18n/messages.js";
import type { AgentMessage, Issue } from "../../protocol/messages.js";
import { displayPath, findImagePaths, splitImagePaths } from "./artifacts.js";
import { diffTurn } from "./log-diff.js";
import { renderMarkdown } from "./markdown.js";
import type { ClientContext } from "./store.js";
import { formatTaskMetrics } from "./task-metrics-format.js";
import type { TimelineItem } from "./timeline.js";
import { formatVerification } from "./verification-format.js";

const VISIBLE_REFERENCE_FILES = 3;
const PLAN_KEY_PREFIX = "plan:";

export function splitReferenceFiles(files: readonly string[]): { visible: string[]; hidden: string[] } {
  return { visible: files.slice(0, VISIBLE_REFERENCE_FILES), hidden: files.slice(VISIBLE_REFERENCE_FILES) };
}

export function createLogItem(ctx: ClientContext) {
  // ---- ログの描画 ----
  const details = (id: string, summary: string, body: HTMLElement, cls: string) => {
    const node = ctx.el("details", cls) as HTMLDetailsElement;
    node.open = ctx.store.opened.get(id) ?? ctx.store.detail;
    node.append(ctx.el("summary", "", summary), body);
    node.addEventListener("toggle", () => ctx.store.opened.set(id, node.open));
    return node;
  };

  const renderPlan = (item: Extract<TimelineItem, { kind: "turn" }>): HTMLElement => {
    const plan = ctx.el("div", "plan");
    const content = ctx.el("div", "plan-content md");
    content.innerHTML = renderMarkdown(item.plan ?? "");
    linkImagePaths(content, item.at);
    plan.append(content);
    const key = `${PLAN_KEY_PREFIX}${item.id}`;
    const expanded = ctx.store.opened.get(key) ?? false;
    plan.classList.toggle("expanded", expanded);
    plan.setAttribute("role", "button");
    plan.setAttribute("aria-expanded", String(expanded));
    plan.tabIndex = 0;
    const toggle = () => {
      const open = plan.classList.toggle("expanded");
      plan.setAttribute("aria-expanded", String(open));
      ctx.store.opened.set(key, open);
    };
    plan.addEventListener("click", event => {
      if ((event.target as Element).closest("a, button, .image-link")) return;
      toggle();
    });
    plan.addEventListener("keydown", event => {
      if (event.target !== plan || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggle();
    });
    return plan;
  };

  // tool 名を短い種類にする（Claude: Read / Bash / mcp__clodex__send_message、Codex: command / clodex.send_message）
  const toolLabel = (name: string) => {
    if (name.includes("send_message")) return ctx.t("web.step.send");
    if (name === "command" || name === "Bash" || name === "PowerShell") return ctx.t("web.step.run");
    const short = name.replace(/^mcp__/, "").toLowerCase();
    return short.length > 8 ? `${short.slice(0, 7)}…` : short;
  };

  // 作業中のターンの経過時間（1 秒ごとに書き換える）
  const elapsedText = (startIso: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / ctx.MS_PER_SECOND));
    const minutes = Math.floor(seconds / ctx.SECONDS_PER_MINUTE);
    return minutes ? ctx.t("web.elapsed.minutes", { minutes, seconds: seconds % ctx.SECONDS_PER_MINUTE }) : ctx.t("web.elapsed.seconds", { seconds });
  };
  // 今の作業: 直近の発言か tool を 1 行で（DESIGN.md §17 ログ）
  const nowLine = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = ctx.el("div", "now");
    const last = item.steps[item.steps.length - 1];
    if (!last) node.append(ctx.el("span", "what muted", ctx.t("web.turn.working")));
    else if (last.kind === "say") node.append(ctx.el("span", "what", last.text.split("\n", 1)[0] ?? ""));
    else node.append(ctx.el("span", "k", toolLabel(last.name)), ctx.el("span", "what mono", last.input));
    return node;
  };

  const imageKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  // 本文の画像のパスをクリックでビューアを開ける要素にする（リンクの中は除く）
  const linkImagePaths = (root: HTMLElement, version: string) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      if (text.parentElement?.closest("a, .image-link")) continue;
      const parts = splitImagePaths(text.data);
      if (!parts.some(part => part.path)) continue;
      text.replaceWith(
        ...parts.map(part => {
          if (!part.path) return document.createTextNode(part.text);
          // 本文にはファイル名だけを出し、フルパスは title とクリックで開くときに使う
          const link = ctx.el("span", "image-link", part.text.split(/[\\/]/).at(-1) ?? part.text);
          link.title = part.path;
          link.dataset.path = part.path;
          link.dataset.version = version;
          link.setAttribute("role", "button");
          link.tabIndex = 0;
          return link;
        }),
      );
    }
  };
  // 読めなかった画像のパスは普通の文字に戻す
  const unlinkImagePath = (root: HTMLElement, path: string) => {
    for (const link of root.querySelectorAll<HTMLElement>(".image-link")) {
      if (imageKey(link.dataset.path ?? "") === imageKey(path)) link.replaceWith(link.textContent ?? "");
    }
  };
  document.addEventListener("click", event => {
    const link = (event.target as Element | null)?.closest?.<HTMLElement>(".image-link");
    if (link?.dataset.path) ctx.openImage(link.dataset.path, link.dataset.version);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const link = (event.target as Element | null)?.closest?.<HTMLElement>(".image-link");
    if (!link?.dataset.path) return;
    event.preventDefault();
    ctx.openImage(link.dataset.path, link.dataset.version);
  });

  const appendImagePreviews = (node: HTMLElement, text: string, version: string) => {
    const paths = findImagePaths(text);
    if (!paths.length) return;
    linkImagePaths(node, version);
    const previews = ctx.el("div", "image-previews");
    for (const path of paths) {
      previews.append(imagePreview(node, path, version));
    }
    node.append(previews);
  };

  const imagePreview = (node: HTMLElement, path: string, version: string) => {
    const button = ctx.el("button", "image-preview") as HTMLButtonElement;
    button.type = "button";
    button.dataset.path = path;
    const image = document.createElement("img");
    image.alt = displayPath(path, ctx.store.state?.project ?? "");
    image.loading = "lazy";
    image.addEventListener("error", () => {
      button.remove();
      unlinkImagePath(node, path);
    });
    image.src = ctx.fileUrl("file", path, version);
    button.addEventListener("click", () => ctx.openImage(path, version));
    button.append(image);
    return button;
  };

  const stepNode = (step: Extract<TimelineItem, { kind: "turn" }>["steps"][number]) => {
    const li = ctx.el("li");
    if (step.kind === "say") li.append(ctx.el("span", "k", ctx.t("web.step.say")), ctx.el("span", "say", step.text));
    else li.append(ctx.el("span", "k", toolLabel(step.name)), ctx.el("span", "run", step.input));
    return li;
  };

  const updateTurn = (
    node: HTMLElement,
    previous: Extract<TimelineItem, { kind: "turn" }>,
    next: Extract<TimelineItem, { kind: "turn" }>,
  ): HTMLElement[] | undefined => {
    const change = diffTurn(previous, next);
    if (change.replace) return undefined;
    const updated: HTMLElement[] = [];
    const head = node.querySelector<HTMLElement>(":scope > .head")!;
    if (change.plan) {
      node.querySelector(":scope > .plan")?.remove();
      if (next.plan) {
        const plan = renderPlan(next);
        head.after(plan);
        updated.push(plan);
      }
    }
    if (change.steps.length) {
      let steps = node.querySelector<HTMLDetailsElement>(":scope > .steps");
      if (!steps) {
        const list = ctx.el("ol");
        steps = details(next.id, "", list, "steps");
        (node.querySelector(":scope > .plan") ?? head).after(steps);
      }
      const list = steps.querySelector("ol")!;
      for (const index of change.steps) {
        const li = stepNode(next.steps[index]!);
        const old = list.children[index];
        if (old) old.replaceWith(li);
        else list.append(li);
      }
      steps.querySelector("summary")!.textContent = ctx.t("web.turn.steps", { count: next.steps.length });
      node.querySelector(":scope > .now")?.replaceWith(nowLine(next));
    }
    if (change.body) {
      node.querySelector(":scope > .body")?.remove();
      if (next.text) {
        const body = ctx.el("div", "body md");
        body.innerHTML = renderMarkdown(next.text);
        linkImagePaths(body, next.at);
        node.querySelector(":scope > .image-previews")?.before(body);
        if (!body.parentNode) node.append(body);
        updated.push(body);
      }
    }
    if (change.images.add.length || change.images.remove.length || change.images.orderChanged) {
      let previews = node.querySelector<HTMLElement>(":scope > .image-previews");
      for (const path of change.images.remove) {
        const key = imageKey(path);
        for (const button of previews?.querySelectorAll<HTMLButtonElement>(".image-preview") ?? []) {
          if (imageKey(button.dataset.path ?? "") === key) button.remove();
        }
      }
      if (change.images.add.length && !previews) {
        previews = ctx.el("div", "image-previews");
        node.append(previews);
      }
      const added = new Set(change.images.add.map(imageKey));
      for (const path of change.images.paths) {
        const button = [...(previews?.querySelectorAll<HTMLButtonElement>(".image-preview") ?? [])].find(
          entry => imageKey(entry.dataset.path ?? "") === imageKey(path),
        );
        if (button) previews!.append(button);
        else if (added.has(imageKey(path))) previews!.append(imagePreview(node, path, next.at));
      }
      if (previews && !previews.children.length) previews.remove();
    }
    return updated;
  };

  const renderTurn = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = ctx.el("article", "entry");
    node.append(ctx.mark(item.agent));
    const head = ctx.el("div", "head");
    head.append(ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name), ctx.el("time", "mono", ctx.clock(item.at)));
    const label = ctx.TURN_LABEL[item.status];
    if (label && item.segment !== "closed") head.append(ctx.el("span", `state ${item.status}`, ctx.t(label)));
    if (item.status === "working" && item.segment !== "closed") {
      const elapsed = ctx.el("span", "elapsed mono", elapsedText(item.at));
      elapsed.dataset.start = item.at;
      head.append(elapsed);
    }
    node.append(head);
    if (item.plan) {
      node.append(renderPlan(item));
    }
    const foldFinal = Boolean(item.messages?.length && !item.questions?.length);
    const finalStep = foldFinal && item.text ? [{ kind: "say" as const, text: item.text, at: item.at }] : [];
    const steps = [...item.steps, ...finalStep];
    if (steps.length) {
      const list = ctx.el("ol");
      for (const step of steps) list.append(stepNode(step));
      node.append(details(item.id, ctx.t("web.turn.steps", { count: steps.length }), list, "steps"));
    }
    if (item.status === "working" && item.segment !== "closed") node.append(nowLine(item));
    if (item.messages?.length || item.questions?.length || item.tells?.length) {
      const body = ctx.el("div", "body");
      let finalPending = !foldFinal && Boolean(item.text);
      const appendFinal = () => {
        if (!finalPending) return;
        const final = ctx.el("div", "md");
        final.innerHTML = renderMarkdown(item.text);
        body.append(final);
        finalPending = false;
      };
      const order = item.attachmentOrder ?? [
        ...(item.messages ?? []).map(entry => ({ kind: "message" as const, id: entry.message.id })),
        ...(item.questions ?? []).map(entry => ({ kind: "question" as const, id: entry.id })),
        ...(item.tells ?? []).map(entry => ({ kind: "tell" as const, id: entry.id })),
      ];
      for (const attached of order) {
        if (attached.kind === "message") {
          const entry = item.messages?.find(message => message.message.id === attached.id);
          if (entry) body.append(renderMessage({ ...entry, id: entry.message.id, at: entry.message.createdAt }));
        } else if (attached.kind === "tell") {
          const entry = item.tells?.find(tell => tell.id === attached.id);
          if (entry) body.append(renderTell(entry, true));
        } else {
          const entry = item.questions?.find(question => question.id === attached.id);
          if (entry) {
            appendFinal();
            if (entry.context) {
              const context = ctx.el("div", "md question-context");
              context.innerHTML = renderMarkdown(entry.context);
              body.append(context);
            }
            body.append(renderQuestion(entry, true));
          }
        }
      }
      appendFinal();
      node.append(body);
    } else {
      const body = ctx.el("div", "body md");
      if (item.text) body.innerHTML = renderMarkdown(item.text);
      else if (item.status === "completed") body.append(ctx.el("span", "muted", ctx.t("web.turn.completed")));
      if (body.childNodes.length) node.append(body);
    }
    appendImagePreviews(node, [item.plan, item.text].filter(Boolean).join("\n"), item.at);
    return node;
  };

  const renderMessage = (item: Pick<Extract<TimelineItem, { kind: "message" }>, "id" | "at" | "message" | "envelope">) => {
    const { message } = item;
    const node = ctx.el("section", "handoff");
    const route = ctx.el("div", "route");
    route.append(ctx.mark(message.from), ctx.el("span", "arrow", "→"), ctx.mark(message.to), ctx.el("span", "kind", message.type));
    const statusKeys: Record<NonNullable<AgentMessage["status"]>, MessageKey> = {
      approved: "web.message.status.approved",
      changes_requested: "web.message.status.changesRequested",
      done: "web.message.status.done",
      failed: "web.message.status.failed",
      canceled: "web.message.status.canceled",
    };
    if (message.status) route.append(ctx.el("span", "kind", ctx.t(statusKeys[message.status])));
    if (message.auto) route.append(ctx.el("span", "kind", ctx.t("web.message.auto")));
    if (message.fresh) route.append(ctx.el("span", "kind", ctx.t("web.message.fresh")));
    if (message.thread) {
      const state = ctx.store.state;
      const child = state?.parallelChildren?.find(conversation => conversation.id === message.thread);
      const label = ctx.t("web.message.parallel", { title: child?.title ?? message.taskId });
      const projectRoot = state?.projects?.find(project => project.current)?.projectRoot;
      if (child && projectRoot) {
        const command = `/tab ${message.thread} ${projectRoot}`;
        const link = ctx.el("button", "kind parallel-link", label) as HTMLButtonElement;
        link.type = "button";
        link.dataset.command = command;
        link.addEventListener("click", () => void ctx.send(command, link));
        route.append(link);
      } else route.append(ctx.el("span", "kind", label));
    }
    if (message.interrupt && !message.fresh) route.append(ctx.el("span", "kind steer", ctx.t("web.steer")));
    route.append(ctx.el("span", "task mono", `${message.taskId} · ${ctx.clock(item.at)}`));
    const text = ctx.el("div", "text md");
    text.innerHTML = renderMarkdown(message.body);
    node.append(route);
    const metrics = message.type === "RESULT" ? ctx.store.state?.taskMetrics?.results[message.id] : undefined;
    if (metrics) node.append(ctx.el("div", "task-metrics muted", formatTaskMetrics(metrics, ctx.t)));
    const verification = formatVerification(message, ctx.t);
    if (verification.checks.length) {
      const checks = ctx.el("div", "verification-checks");
      for (const check of verification.checks)
        checks.append(ctx.el("span", `verification-chip mono${check.warning ? " verification-warning" : ""}`, check.text));
      node.append(checks);
    }
    if (verification.changed) {
      if (verification.root) node.append(ctx.el("small", "verification-root muted mono", verification.root));
      const files = ctx.el("ul", "verification-list mono");
      for (const file of verification.files) files.append(ctx.el("li", file.warning ? "verification-warning" : "", file.text));
      node.append(details(`evidence:${item.id}`, verification.changed, files, "verification-files"));
    }
    if (verification.specCheck) {
      const check = verification.specCheck;
      const diagnostic = details(`spec-check:${item.id}`, check.text, ctx.el("pre", "", check.output), "spec-check");
      if (check.warning) diagnostic.classList.add("verification-warning");
      node.append(diagnostic);
    }
    node.append(text);
    appendImagePreviews(node, message.body, item.at);
    if (message.spec || message.files?.length) {
      const refs = ctx.el("div", "refs");
      if (message.spec) {
        const spec = message.spec;
        const ref = ctx.el("button", "ref spec", `${ctx.t("web.message.spec")}: ${spec}`) as HTMLButtonElement;
        ref.type = "button";
        ref.addEventListener("click", () => void ctx.openViewer(spec));
        refs.append(ref);
      }
      const fileRef = (file: string) => {
        const ref = ctx.el("button", "ref", file) as HTMLButtonElement;
        ref.type = "button";
        ref.addEventListener("click", () => void ctx.openViewer(file));
        return ref;
      };
      const { visible, hidden } = splitReferenceFiles(message.files ?? []);
      for (const file of visible) refs.append(fileRef(file));
      if (hidden.length) {
        const key = `refs:${item.id}`;
        const more = ctx.el("details", "refs-more") as HTMLDetailsElement;
        more.open = ctx.store.opened.get(key) ?? false;
        const extra = ctx.el("div", "refs");
        for (const file of hidden) extra.append(fileRef(file));
        more.append(ctx.el("summary", "", ctx.t("web.message.moreFiles", { count: hidden.length })), extra);
        more.addEventListener("toggle", () => ctx.store.opened.set(key, more.open));
        refs.append(more);
      }
      node.append(refs);
    }
    const severityKeys: Record<Issue["severity"], MessageKey> = {
      low: "web.issue.low",
      medium: "web.issue.medium",
      high: "web.issue.high",
      critical: "web.issue.critical",
    };
    for (const issue of message.issues ?? []) {
      const finding = ctx.el("div", `finding ${issue.severity}`);
      finding.append(
        ctx.el("span", "sev", ctx.t(severityKeys[issue.severity])),
        ctx.el("span", "loc", issue.line ? `${issue.file}:${issue.line}` : issue.file),
        ctx.el("span", "desc", issue.summary),
      );
      node.append(finding);
    }
    if (item.envelope)
      node.append(details(item.id, ctx.t("web.message.envelope", { agent: ctx.AGENTS[message.to].name }), ctx.el("pre", "", item.envelope), "envelope"));
    return node;
  };

  const renderQuestion = (item: Extract<TimelineItem, { kind: "question" }>, embedded = false): HTMLElement => {
    const node = embedded ? ctx.el("section", "question-card") : ctx.el("article", `entry question ${item.agent}`);
    const head = ctx.el("div", "head");
    head.append(
      ...(embedded ? [] : [ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name)]),
      ctx.el("time", "mono", ctx.clock(item.at)),
      ctx.el("span", "kind", ctx.t(item.answers ? "web.question.answered" : "web.question.waiting")),
    );
    if (!embedded) node.append(ctx.mark(item.agent));
    if (!embedded && item.context) {
      const context = ctx.el("div", "md question-context");
      context.innerHTML = renderMarkdown(item.context);
      node.append(context);
    }
    node.append(head);
    const previewText = item.questions.flatMap(question => [question.question, ...question.options.map(option => option.description ?? "")]).join("\n");
    const record = ctx.el("dl", "question-record");
    item.questions.forEach((question, index) => {
      const choices =
        item.answers?.[index]?.join(", ") ??
        question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
      record.append(ctx.el("dt", "", question.question), ctx.el("dd", "", choices));
    });
    node.append(record);
    appendImagePreviews(node, previewText, item.at);
    return node;
  };
  const renderTell = (item: Extract<TimelineItem, { kind: "tell" }>, embedded = false): HTMLElement => {
    const node = ctx.el(embedded ? "div" : "article", embedded ? "tell" : "entry");
    if (!embedded) {
      const head = ctx.el("div", "head");
      head.append(ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name), ctx.el("time", "mono", ctx.clock(item.at)));
      node.append(ctx.mark(item.agent), head);
    }
    const body = ctx.el("div", embedded ? "md" : "body md");
    body.innerHTML = renderMarkdown(item.body);
    node.append(body);
    appendImagePreviews(node, item.body, item.at);
    return node;
  };
  return { appendImagePreviews, elapsedText, renderQuestion, renderTell, renderTurn, renderMessage, updateTurn };
}
