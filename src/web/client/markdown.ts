// Agent の応答の簡易 Markdown を HTML にする（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く
export function renderMarkdown(source: string): string {
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  // インラインコードを先に切り出し、それ以外の部分だけ太字にする
  const inline = (s: string) =>
    s.split("`").map((part, i) => {
      const escaped = escape(part);
      return i % 2 === 1 ? `<code>${escaped}</code>` : escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }).join("");

  const out: string[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  type ListTag = "ul" | "ol";
  type ChildList = { tag: ListTag; start?: number; items: string[] };
  let list: { tag: ListTag; start?: number; items: { text: string; children: ChildList[] }[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((item) => {
        const children = item.children.map((child) =>
          `<${child.tag}${child.start && child.start !== 1 ? ` start="${child.start}"` : ""}>${child.items.map((text) => `<li>${inline(text)}</li>`).join("")}</${child.tag}>`).join("");
        return `<li>${inline(item.text)}${children}</li>`;
      }).join("");
      out.push(`<${list.tag}${list.start && list.start !== 1 ? ` start="${list.start}"` : ""}>${items}</${list.tag}>`);
    }
    list = undefined;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```"); i++) code.push(lines[i] ?? "");
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      out.push(`<p class="md-h">${inline(heading[1] ?? "")}</p>`);
      continue;
    }
    const item = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      const marker = item[2] ?? "";
      const tag: ListTag = marker === "-" || marker === "*" ? "ul" : "ol";
      const start = tag === "ol" ? Number.parseInt(marker, 10) : undefined;
      if ((item[1]?.length ?? 0) >= 2 && list?.items.length) {
        const parent = list.items[list.items.length - 1]!;
        let child = parent.children[parent.children.length - 1];
        if (child?.tag !== tag) {
          child = { tag, start, items: [] };
          parent.children.push(child);
        }
        child.items.push(item[3] ?? "");
        continue;
      }
      if (list?.tag !== tag) flushList();
      list ??= { tag, start, items: [] };
      list.items.push({ text: item[3] ?? "", children: [] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return out.join("");
}
