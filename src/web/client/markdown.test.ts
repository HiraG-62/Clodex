import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("段落内の単独改行を br にする", () => {
    expect(renderMarkdown("一行目\n二行目\n\n次の段落")).toContain("<p>一行目<br>二行目</p>");
    expect(renderMarkdown("一行目\n二行目\n\n次の段落")).toContain("<p>次の段落</p>");
  });

  it("生の HTML は文字として表示し、コード内も安全にする", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n`<b>`');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("<code>&lt;b&gt;</code>");
    expect(html).not.toContain("<script>");
  });

  it("GFM の引用・表・区切り線を描く", () => {
    const html = renderMarkdown("> 引用\n> 続き\n\n| 名前 | 値 |\n|---|---|\n| A | 1 |\n\n---");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("引用<br>続き");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>名前</th>");
    expect(html).toContain("<td>A</td>");
    expect(html).toContain("<hr>");
  });

  it("http/https のリンクだけを別タブで開き、危険な URL は文字にする", () => {
    const html = renderMarkdown("[安全](https://example.com/?a=1&b=2) [HTTP](http://example.com) [危険](javascript:alert(1))");
    expect(html).toContain('<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">安全</a>');
    expect(html).toContain('<a href="http://example.com" target="_blank" rel="noopener noreferrer">HTTP</a>');
    expect(html).toContain("危険");
    expect(html).not.toContain("javascript:");
  });

  it("太字・斜体・取り消し線を描き、コード内は解釈しない", () => {
    expect(renderMarkdown("**太字** *斜体* ~~削除~~ `**code**`")).toContain("<strong>太字</strong> <em>斜体</em> <del>削除</del> <code>**code**</code>");
  });

  it("入れ子のリストと書かれた開始番号を保つ", () => {
    const html = renderMarkdown("3. 親\n   - 子\n4. 次");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<li>親<ul>");
    expect(html).toContain("<li>子</li>");
    expect(html).toContain("<li>次</li>");
  });

  it("見出しとコードブロックを描く", () => {
    const html = renderMarkdown("## 結果\n\n```ts\nconst a = 1 < 2;\n```");
    expect(html).toContain('<p class="md-h">結果</p>');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;');
  });

  it("空文字は空", () => expect(renderMarkdown("")).toBe(""));

  it("画像記法は説明とパスを文字で残し、画像を埋め込まない", () => {
    const html = renderMarkdown(String.raw`![説明](<C:\x\a.png>) ![](<C:\x\b.png>)`);
    expect(html).toContain(String.raw`説明 C:\x\a.png`);
    expect(html).toContain(String.raw`C:\x\b.png`);
    expect(html).not.toContain("<img");
  });
});

it("絶対パスのインラインコードに abs-path の class を付け、ほかのコードには付けない", () => {
  expect(renderMarkdown("`C:\\Users\\a.png` と `C:/x/y.ts` と `/tmp/a` と `~/b`")).toBe(
    '<p><code class="abs-path">C:\\Users\\a.png</code> と <code class="abs-path">C:/x/y.ts</code> と <code class="abs-path">/tmp/a</code> と <code class="abs-path">~/b</code></p>\n',
  );
  expect(renderMarkdown("`src/a.ts` と `/limits` と `<b>`")).toBe("<p><code>src/a.ts</code> と <code>/limits</code> と <code>&lt;b&gt;</code></p>\n");
});
