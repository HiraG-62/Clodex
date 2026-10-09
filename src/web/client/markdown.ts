// Web と TUI で marked の GFM 解析を共有する。
import { marked } from "marked";

export function renderMarkdown(source: string): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
  const safeUrl = (href: string) => {
    try {
      const url = new URL(href);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch { return false; }
  };
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escape(text);
  renderer.heading = ({ tokens }) => `<p class="md-h">${renderer.parser.parseInline(tokens)}</p>`;
  renderer.link = ({ href, tokens }) => {
    const label = renderer.parser.parseInline(tokens);
    return safeUrl(href) ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  };
  renderer.image = ({ text, href }) => [text, href].filter(Boolean).map(escape).join(" ");
  // 絶対パスは本文より目立たないよう控えめに出す。/limits のようなコマンドは区切りが 1 つなので含めない
  const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/[^\s/]+\/)/;
  renderer.codespan = ({ text }) => `<code${ABSOLUTE_PATH.test(text) ? ' class="abs-path"' : ""}>${escape(text)}</code>`;
  return marked.parse(source, { gfm: true, breaks: true, renderer }) as string;
}
