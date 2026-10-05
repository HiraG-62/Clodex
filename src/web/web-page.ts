// Web UI の画面。依存を増やさないよう HTML 1 枚に CSS / JS を inline で持つ（DESIGN.md §17 Web UI）
export const WEB_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>Clodex</title>
<link rel="icon" href="data:,">
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #2a2f3a; --text: #d7dae0; --muted: #8b93a1;
    --claude: #e8a87c; --codex: #7cc4e8; --message: #c39bf0; --notice: #e8d27c; --error: #f07c7c; --you: #9be89b;
    --accent: #4f8cff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --panel: #ffffff; --border: #d8dce3; --text: #1d2129; --muted: #677084;
      --claude: #b5652c; --codex: #1f7aa8; --message: #7b4bb8; --notice: #8a6d00; --error: #c0392b; --you: #2e7d32;
      --accent: #2f6fe0;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
  body { display: flex; flex-direction: column; height: 100dvh; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; padding-top: max(10px, env(safe-area-inset-top));
    background: var(--panel); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #conn { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  #conn::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--error); }
  #conn.online::before { background: var(--you); }
  #log { flex: 1; overflow-y: auto; padding: 8px 16px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 13px; line-height: 1.5; }
  .line { white-space: pre-wrap; overflow-wrap: anywhere; padding: 2px 0; }
  .time { color: var(--muted); }
  .tag-claude { color: var(--claude); } .tag-codex { color: var(--codex); } .tag-message { color: var(--message); }
  .tag-notice { color: var(--notice); } .tag-you { color: var(--you); } .error { color: var(--error); }
  .plain { color: var(--muted); }
  footer { background: var(--panel); border-top: 1px solid var(--border); padding: 8px 16px;
    padding-bottom: max(8px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
  .actions { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
  .actions::-webkit-scrollbar { display: none; }
  button, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; }
  .actions button { padding: 6px 12px; font-size: 13px; white-space: nowrap; min-height: 36px; }
  .actions button.danger { color: var(--error); }
  form { display: flex; gap: 8px; align-items: flex-end; }
  select { padding: 8px 6px; min-height: 44px; }
  textarea { flex: 1; resize: none; padding: 10px; min-height: 44px; max-height: 40vh; font-size: 16px; overflow-y: hidden; }
  form button { padding: 0 16px; min-height: 44px; background: var(--accent); color: #fff; border: none; font-weight: 600; }
  button:active { opacity: .7; }
</style>
</head>
<body>
<header><h1>Clodex</h1><span id="conn">offline</span></header>
<div id="log" aria-live="polite"></div>
<footer>
  <div class="actions">
    <button type="button" class="danger" data-command="/interrupt">Interrupt</button>
    <button type="button" data-command="/status">Status</button>
    <button type="button" data-command="/compact">Compact</button>
    <button type="button" data-command="/verbose">Verbose</button>
    <button type="button" data-command="/help">Help</button>
  </div>
  <form id="form">
    <select id="target" aria-label="送り先">
      <option value="">primary</option>
      <option value="@claude ">claude</option>
      <option value="@codex ">codex</option>
    </select>
    <textarea id="input" rows="1" placeholder="メッセージ / コマンド" enterkeyhint="send"></textarea>
    <button type="submit">送信</button>
  </form>
</footer>
<script>
  const log = document.getElementById("log");
  const conn = document.getElementById("conn");
  const input = document.getElementById("input");
  const target = document.getElementById("target");
  const TAGS = [["[CLAUDE]", "tag-claude"], ["[CODEX]", "tag-codex"], ["[MESSAGE]", "tag-message"],
    ["[CLODEX]", "tag-notice"], ["[YOU", "tag-you"]];

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

  const render = (text) => {
    const stick = nearBottom();
    const div = document.createElement("div");
    div.className = "line";
    const match = text.match(/^(\\d\\d:\\d\\d:\\d\\d) (\\[[^\\]]+\\])([\\s\\S]*)$/);
    if (match) {
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = match[1] + " ";
      const tag = document.createElement("span");
      tag.className = (TAGS.find(([prefix]) => match[2].startsWith(prefix)) || [, ""])[1];
      tag.textContent = match[2];
      const body = document.createElement("span");
      body.textContent = match[3];
      if (/^ ERROR /.test(match[3])) body.className = "error";
      div.append(time, tag, body);
    } else {
      div.className += " plain";
      div.textContent = text;
    }
    log.append(div);
    if (stick) log.scrollTop = log.scrollHeight;
  };

  const connect = () => {
    const events = new EventSource("/events");
    // 接続（再接続を含む）のたびに直近の行が送り直されるので、画面を作り直す
    events.onopen = () => { log.replaceChildren(); conn.textContent = "online"; conn.className = "online"; };
    events.onmessage = (e) => render(JSON.parse(e.data));
    events.onerror = () => { conn.textContent = "reconnecting"; conn.className = ""; };
  };

  const send = async (line) => {
    const response = await fetch("/api/input", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line }),
    });
    if (!response.ok) render("送信に失敗しました（" + response.status + "）");
  };

  document.getElementById("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send(text.startsWith("/") || text.startsWith("@") ? text : target.value + text);
    input.value = "";
    input.style.height = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      document.getElementById("form").requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = input.scrollHeight + "px";
    // 高さの上限を超えたときだけスクロールさせる
    input.style.overflowY = input.scrollHeight > input.clientHeight ? "auto" : "hidden";
  });
  document.querySelectorAll("[data-command]").forEach((b) => b.addEventListener("click", () => send(b.dataset.command)));

  connect();
</script>
</body>
</html>
`;
