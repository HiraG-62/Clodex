import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("段落と改行", () => {
    expect(renderMarkdown("一行目\n二行目\n\n次の段落")).toBe("<p>一行目<br>二行目</p><p>次の段落</p>");
  });

  it("HTML はエスケープする（インラインコードの中も）", () => {
    expect(renderMarkdown('<script>alert("x")</script> `<b>`'))
      .toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <code>&lt;b&gt;</code></p>");
  });

  it("インラインコードと太字。コードの中の ** は太字にしない", () => {
    expect(renderMarkdown("**重要** は `a ** b` です")).toBe("<p><strong>重要</strong> は <code>a ** b</code> です</p>");
  });

  it("コードブロック（言語指定は捨てる）", () => {
    expect(renderMarkdown("前\n```ts\nconst a = 1 < 2;\n\n```\n後"))
      .toBe("<p>前</p><pre><code>const a = 1 &lt; 2;\n</code></pre><p>後</p>");
  });

  it("閉じていないコードブロックは最後までコードとして扱う", () => {
    expect(renderMarkdown("```\nx")).toBe("<pre><code>x</code></pre>");
  });

  it("箇条書きと番号付きリスト", () => {
    expect(renderMarkdown("- a\n- `b`\n\n1. one\n2. two"))
      .toBe("<ul><li>a</li><li><code>b</code></li></ul><ol><li>one</li><li>two</li></ol>");
  });

  it("見出しは太字の段落にする", () => {
    expect(renderMarkdown("## 結果\n本文")).toBe('<p class="md-h">結果</p><p>本文</p>');
  });

  it("空文字は空", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
