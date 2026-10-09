import type { MessageKey } from "../../i18n/messages.js";
import type { AgentMessage, Issue } from "../../protocol/messages.js";
import { displayPath, findImagePaths, splitImagePaths } from "./artifacts.js";
import { diffTurn } from "./log-diff.js";
import { renderMarkdown } from "./markdown.js";
import type { ClientContext } from "./store.js";
import type { TimelineItem } from "./timeline.js";

export function createLogItem(ctx: ClientContext) {
  // ---- ログの描画 ----
  const details = (id: string, summary: string, body: HTMLElement, cls: string) => {
    const node = ctx.el("details", cls) as HTMLDetailsElement;
    node.open = ctx.store.opened.get(id) ?? ctx.store.detail;
    node.append(ctx.el("summary", "", summary), body);
    node.addEventListener("toggle", () => ctx.store.opened.set(id, node.open));
    return node;
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
        const plan = ctx.el("div", "plan md");
        plan.innerHTML = renderMarkdown(next.plan);
        linkImagePaths(plan, next.at);
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
    if (label) head.append(ctx.el("span", `state ${item.status}`, ctx.t(label)));
    if (item.status === "working") {
      const elapsed = ctx.el("span", "elapsed mono", elapsedText(item.at));
      elapsed.dataset.start = item.at;
      head.append(elapsed);
    }
    node.append(head);
    if (item.plan) {
      const plan = ctx.el("div", "plan md");
      plan.innerHTML = renderMarkdown(item.plan);
      node.append(plan);
    }
    const finalStep = item.messages?.length && item.text ? [{ kind: "say" as const, text: item.text, at: item.at }] : [];
    const steps = [...item.steps, ...finalStep];
    if (steps.length) {
      const list = ctx.el("ol");
      for (const step of steps) list.append(stepNode(step));
      node.append(details(item.id, ctx.t("web.turn.steps", { count: steps.length }), list, "steps"));
    }
    if (item.status === "working") node.append(nowLine(item));
    if (item.messages?.length) {
      const body = ctx.el("div", "body");
      for (const entry of item.messages) body.append(renderMessage({ ...entry, id: entry.message.id, at: entry.message.createdAt }));
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
    };
    if (message.status) route.append(ctx.el("span", "kind", ctx.t(statusKeys[message.status])));
    if (message.auto) route.append(ctx.el("span", "kind", ctx.t("web.message.auto")));
    if (message.interrupt) route.append(ctx.el("span", "kind steer", ctx.t("web.steer")));
    route.append(ctx.el("span", "task mono", `${message.taskId} · ${ctx.clock(item.at)}`));
    const text = ctx.el("div", "text md");
    text.innerHTML = renderMarkdown(message.body);
    node.append(route, text);
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
      for (const file of message.files ?? []) {
        const ref = ctx.el("button", "ref", file) as HTMLButtonElement;
        ref.type = "button";
        ref.addEventListener("click", () => void ctx.openViewer(file));
        refs.append(ref);
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

  const renderQuestion = (item: Extract<TimelineItem, { kind: "question" }>): HTMLElement => {
    const node = ctx.el("article", `entry question ${item.agent}`);
    const head = ctx.el("div", "head");
    head.append(
      ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name),
      ctx.el("time", "mono", ctx.clock(item.at)),
      ctx.el("span", "kind", ctx.t(item.answers ? "web.question.answered" : "web.question.waiting")),
    );
    node.append(ctx.mark(item.agent), head);
    const previewText = item.questions.flatMap(question => [question.question, ...question.options.map(option => option.description ?? "")]).join("\n");
    if (!item.answers) {
      appendImagePreviews(node, previewText, item.at);
      return node;
    }
    const record = ctx.el("dl", "question-record");
    item.questions.forEach((question, index) => record.append(ctx.el("dt", "", question.question), ctx.el("dd", "", (item.answers?.[index] ?? []).join(", "))));
    node.append(record);
    appendImagePreviews(node, previewText, item.at);
    return node;
  };
  return { appendImagePreviews, elapsedText, renderQuestion, renderTurn, renderMessage, updateTurn };
}
