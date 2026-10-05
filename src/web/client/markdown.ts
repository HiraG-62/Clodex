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
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
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
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? "");
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
