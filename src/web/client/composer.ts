import type { AgentId } from "../../agents/agent-adapter.js";
import type { HistoryPage } from "../web-feed.js";
import { composeInputLine } from "./compose-input.js";
import type { Suggestion } from "./input-assist.js";
import { createInputAssist } from "./input-assist.js";
import { isSendKey } from "./send-key.js";
import { isShellInput } from "./shell-input.js";
import type { ClientContext } from "./store.js";
import { applyFeedItem, rebuildTimeline } from "./timeline.js";

export function createComposer(ctx: ClientContext) {
  // ---- 入力 ----
  const coarse = ctx.mobile.matches;
  const resize = () => {
    const stick = ctx.nearBottom();
    ctx.input.style.height = "";
    // 空欄の scrollHeight は折り返したプレースホルダの高さになるため、1 行のままにする
    if (ctx.input.value) ctx.input.style.height = `${ctx.input.scrollHeight}px`;
    ctx.input.style.overflowY = ctx.input.scrollHeight > ctx.input.clientHeight ? "auto" : "hidden";
    if (stick) requestAnimationFrame(ctx.scrollToBottom);
  };
  const saveDraft = (key: string, value: string) => {
    if (value) ctx.storage.set(key, value);
    else ctx.storage.remove(key);
  };
  // 送信に成功してから入力欄を空にする（失敗しても書いた内容を失わない）
  const sendButton = ctx.$("#composer .send") as HTMLButtonElement;
  const submit = async () => {
    const text = ctx.input.value.trim();
    if (!text || sendButton.disabled || ctx.store.uploading > 0) return;
    const submittedDraftKey = ctx.store.currentDraftKey;
    const to = ctx.store.target ?? ctx.store.state?.primary;
    const sent = await ctx.send(composeInputLine(text, to), sendButton);
    sendButton.disabled = ctx.store.uploading > 0;
    if (!sent) return;
    if (submittedDraftKey) ctx.storage.remove(submittedDraftKey);
    if (ctx.store.currentDraftKey === submittedDraftKey && ctx.input.value.trim() === text) ctx.input.value = "";
    onInputChanged();
    ctx.scrollToBottom();
  };
  ctx.$("#composer").addEventListener("submit", e => {
    e.preventDefault();
    void submit();
  });
  // ---- 入力の補助（候補と強調表示。DESIGN.md §28 v0.3 A） ----
  const assist = createInputAssist(ctx.commands, ctx.AGENT_IDS, {
    agent: ctx.t("web.assist.agent"),
    file: ctx.t("web.assist.file"),
    permission: ctx.t("web.assist.permission"),
    effort: ctx.t("web.assist.effort"),
    model: ctx.t("web.assist.model"),
    conversation: ctx.t("web.assist.conversation"),
    project: ctx.t("web.assist.project"),
    worktree: ctx.t("web.assist.worktree"),
    queued: ctx.t("web.assist.queued"),
  });
  const highlightLayer = ctx.$("#input-highlight");
  const suggestList = ctx.$("#suggest");
  ctx.store.files = [];
  ctx.store.fileSet = new Set<string>();
  ctx.store.filesLoadedAt = 0;
  ctx.store.filesLoading = false;
  ctx.store.filesGeneration = 0;
  let suggestion: Suggestion | undefined;
  let selected = 0;

  const renderHighlight = () => {
    const nodes: Node[] = assist.highlight(ctx.input.value, ctx.store.fileSet).map(segment => {
      if (!segment.kind) return document.createTextNode(segment.text);
      return ctx.el("mark", segment.kind === "agent" ? `hl-${segment.text.slice(1).replace(/!$/, "")}` : `hl-${segment.kind}`, segment.text);
    });
    // 末尾の改行も高さに反映されるよう、幅の無い文字を足す
    highlightLayer.replaceChildren(...nodes, document.createTextNode("\u200b"));
    highlightLayer.scrollTop = ctx.input.scrollTop;
  };
  const closeSuggest = () => {
    suggestion = undefined;
    suggestList.hidden = true;
    ctx.input.setAttribute("aria-expanded", "false");
  };
  const accept = (index: number) => {
    const item = suggestion?.items[index];
    if (!suggestion || !item) return;
    const { from, to } = suggestion;
    ctx.input.value = ctx.input.value.slice(0, from) + item.insert + ctx.input.value.slice(to).replace(/^ /, "");
    const caret = from + item.insert.length;
    ctx.input.focus();
    ctx.input.setSelectionRange(caret, caret);
    onInputChanged();
  };
  const renderSuggest = () => {
    const loading = ctx.store.filesLoading && /(?:^|\s)@[^\s]*$/.test(ctx.input.value.slice(0, ctx.input.selectionStart));
    if (!suggestion && !loading) return closeSuggest();
    suggestList.replaceChildren(
      ...(suggestion?.items ?? []).map((item, index) => {
        const option = ctx.el("li");
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selected));
        option.append(ctx.el("span", "l", item.label), ctx.el("span", "d", item.detail));
        // 入力欄のフォーカスを外さずに選ぶ
        option.addEventListener("pointerdown", e => e.preventDefault());
        option.addEventListener("click", () => accept(index));
        // タッチでは click の前に入力欄の blur で一覧が閉じるので、指を離した時点で選ぶ。スクロールした指は選ばない
        let touchY: number | undefined;
        option.addEventListener(
          "touchstart",
          e => {
            touchY = e.touches[0]?.clientY;
          },
          { passive: true },
        );
        option.addEventListener("touchend", e => {
          const endY = e.changedTouches[0]?.clientY;
          if (touchY === undefined || endY === undefined || Math.abs(endY - touchY) > ctx.SUGGEST_TAP_SLOP_PX) return;
          e.preventDefault();
          accept(index);
        });
        return option;
      }),
    );
    if (loading) {
      const row = ctx.el("li", "muted", ctx.t("web.files.loading"));
      row.prepend(ctx.el("span", "spin"));
      row.setAttribute("role", "option");
      row.setAttribute("aria-disabled", "true");
      suggestList.append(row);
    }
    suggestList.hidden = false;
    ctx.input.setAttribute("aria-expanded", "true");
    suggestList.children[selected]?.scrollIntoView({ block: "nearest" });
  };
  const updateSuggest = () => {
    const caret = ctx.input.selectionStart;
    suggestion = caret === ctx.input.selectionEnd ? assist.suggest(ctx.input.value, caret, ctx.store.files, ctx.store.state) : undefined;
    selected = 0;
    renderSuggest();
  };
  const loadFiles = async () => {
    if (ctx.store.filesLoading || Date.now() - ctx.store.filesLoadedAt < ctx.FILES_REFRESH_MS) return;
    const generation = ctx.store.filesGeneration;
    ctx.store.filesLoading = true;
    updateSuggest();
    try {
      const response = await fetch("/api/files");
      if (!response.ok || generation !== ctx.store.filesGeneration) return;
      const loaded = (await response.json()) as string[];
      if (generation !== ctx.store.filesGeneration) return;
      ctx.store.files = loaded;
      ctx.store.fileSet = new Set(ctx.store.files);
      renderHighlight();
    } catch {
      /* 候補が出ないだけで入力はできる */
    } finally {
      if (generation === ctx.store.filesGeneration) {
        ctx.store.filesLoading = false;
        ctx.store.filesLoadedAt = Date.now();
        if (document.activeElement === ctx.input) updateSuggest();
      }
    }
  };
  // コマンド入力中と、solo で送り先が固定されているときは送り先を変えられない
  function syncTargetButtons() {
    const shell = isShellInput(ctx.input.value);
    const solo = ctx.store.state?.conversations.find(conversation => conversation.current)?.solo;
    const disabled = shell || Boolean(solo && solo !== "free");
    for (const button of document.querySelectorAll<HTMLButtonElement>(".to button, #target-toggle")) button.disabled = disabled;
    ctx.$("#target-toggle").replaceChildren(shell ? ctx.icon("terminal") : ctx.mark(ctx.store.target ?? ctx.store.state?.primary ?? "claude"));
    ctx
      .$("#target-toggle")
      .setAttribute(
        "aria-label",
        shell ? ctx.t("web.shellInput") : `${ctx.t("web.to.label")}: ${ctx.AGENTS[ctx.store.target ?? ctx.store.state?.primary ?? "claude"].name}`,
      );
    ctx.$("#target-toggle").title = ctx.$("#target-toggle").getAttribute("aria-label")!;
  }
  function onInputChanged() {
    if (ctx.store.currentDraftKey) saveDraft(ctx.store.currentDraftKey, ctx.input.value);
    const shell = isShellInput(ctx.input.value);
    ctx.$("#composer").classList.toggle("shell-input", shell);
    sendButton.replaceChildren(ctx.icon(shell ? "terminal" : "arrow-up"));
    sendButton.setAttribute("aria-label", ctx.t(shell ? "web.run" : "web.send"));
    sendButton.title = ctx.t(shell ? "web.run" : "web.send");
    syncTargetButtons();
    resize();
    renderHighlight();
    updateSuggest();
    if (/(?:^|\s)@/.test(ctx.input.value)) void loadFiles();
  }

  // ---- 画像の添付（DESIGN.md §28 v0.3 C）: 保存してから @<パス> を入力欄に足す ----
  const insertAtCaret = (text: string) => {
    const start = ctx.input.selectionStart;
    const before = ctx.input.value.slice(0, start);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    ctx.input.value = `${before}${spacer}${text}${ctx.input.value.slice(ctx.input.selectionEnd)}`;
    const caret = before.length + spacer.length + text.length;
    ctx.input.setSelectionRange(caret, caret);
    onInputChanged();
  };
  const attach = async (file: Blob) => {
    const generation = ctx.store.liveGeneration;
    ctx.store.uploading++;
    ctx.$("#upload-status").hidden = false;
    sendButton.disabled = true;
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
      if (!response.ok) return ctx.showToast(ctx.t("web.upload.failed"));
      const { path } = (await response.json()) as { path: string };
      if (generation === ctx.store.liveGeneration) insertAtCaret(`@${path} `);
    } catch {
      ctx.showToast(ctx.t("web.upload.failed"));
    } finally {
      ctx.store.uploading--;
      ctx.$("#upload-status").hidden = ctx.store.uploading === 0;
      sendButton.disabled = ctx.store.uploading > 0 || sendButton.classList.contains("is-loading");
    }
  };
  const fileInput = document.querySelector<HTMLInputElement>("#attach-file")!;
  ctx.$("#attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    for (const file of fileInput.files ?? []) void attach(file);
    fileInput.value = "";
  });
  ctx.input.addEventListener("paste", e => {
    const images = [...(e.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    for (const image of images) void attach(image);
  });

  ctx.input.addEventListener("input", onInputChanged);
  ctx.input.addEventListener("focus", () => void loadFiles());
  ctx.input.addEventListener("blur", closeSuggest);
  ctx.input.addEventListener("scroll", () => {
    highlightLayer.scrollTop = ctx.input.scrollTop;
  });
  ctx.input.addEventListener("click", updateSuggest);
  ctx.input.addEventListener("keyup", e => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateSuggest();
  });
  // PC は送信キーの設定で送信。スマホは Enter で改行し、送信はボタン（日本語入力の誤送信を防ぐ）
  ctx.input.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (suggestion) {
      const count = suggestion.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
        return renderSuggest();
      }
      // Enter は候補を確定しない（入力のまま送れるように）
      if (e.key === "Tab") {
        e.preventDefault();
        return accept(selected);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return closeSuggest();
      }
    }
    if (!isSendKey(e, ctx.store.sendKey, ctx.mobile.matches)) return;
    e.preventDefault();
    void submit();
  });
  ctx.input.placeholder = ctx.t(coarse ? "web.input.placeholderTouch" : "web.input.placeholder");
  for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
    button.addEventListener("click", () => {
      ctx.store.target = button.dataset.agent as AgentId;
      ctx.renderState();
    });
  }

  ctx.newer.addEventListener("click", ctx.scrollToBottom);
  setInterval(() => {
    for (const node of ctx.log.querySelectorAll<HTMLElement>(".elapsed[data-start]")) node.textContent = ctx.elapsedText(node.dataset.start ?? "");
    for (const node of document.querySelectorAll<HTMLElement>("#working-panel .elapsed[data-start], #agents .elapsed[data-start]"))
      node.textContent = ctx.elapsedText(node.dataset.start ?? "");
  }, ctx.MS_PER_SECOND);
  const loadHistory = async () => {
    const oldest = ctx.store.history[0];
    if (!oldest || ctx.store.historyLoading || !ctx.store.historyHasMore || ctx.store.replaying) return;
    const generation = ctx.store.historyGeneration;
    ctx.store.historyLoading = true;
    ctx.$("#history-loading").hidden = false;
    try {
      const response = await fetch(`/api/history?before=${oldest.seq}`);
      if (!response.ok) throw new Error(String(response.status));
      const page = (await response.json()) as HistoryPage;
      if (generation !== ctx.store.historyGeneration) return;
      ctx.store.historyHasMore = page.hasMore;
      const previousHeight = ctx.log.scrollHeight;
      const previousTop = ctx.log.scrollTop;
      ctx.store.history = [...page.items, ...ctx.store.history];
      ctx.store.historyLoading = false;
      const queued = new Set(ctx.store.items.filter(item => item.kind === "human" && item.queued).map(item => item.id));
      ctx.store.items = rebuildTimeline(ctx.store.history, applyFeedItem).map(item =>
        item.kind === "human" && queued.has(item.id) ? { ...item, queued: true } : item,
      );
      ctx.renderLog();
      ctx.log.scrollTop = previousTop + ctx.log.scrollHeight - previousHeight;
      ctx.syncNewer();
    } catch {
      if (generation === ctx.store.historyGeneration) ctx.showToast(ctx.t("web.history.failed"), "warn");
    } finally {
      if (generation === ctx.store.historyGeneration) {
        ctx.store.historyLoading = false;
        ctx.$("#history-loading").hidden = true;
      }
    }
  };
  ctx.log.addEventListener("scroll", () => {
    ctx.syncNewer();
    if (ctx.log.scrollTop <= ctx.HISTORY_THRESHOLD_PX) void loadHistory();
  });
  return { syncTargetButtons, onInputChanged, saveDraft, loadFiles };
}
