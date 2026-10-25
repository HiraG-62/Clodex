# GEMINI-EFFORT: Gemini の effort を廃止する（model に含まれるため）

`agy models` の slug はすべて effort 込み（`gemini-3.8-flash-low` など）で、`--effort` を併用すると矛盾した組み合わせで起動直後に exit 1 になる（`docs/spikes/antigravity.md` の 2026-10-25 実測）。Gemini の effort 設定を無くし、model の切り替えに一本化する。仕様の正は `docs/DESIGN.md` §9 Model / Effort（更新済み）。

## Fixed

- `src/agents/agent-meta.ts`: `AGENT_META.gemini.effortLevels` を `[]` にする
- `src/agents/antigravity-adapter.ts`: 起動引数から `--effort` を外し、`setEffort` の override を消す（gemini に effort を設定する経路を残さない）
- `/effort` の入力（`src/cli/input.ts` ほか該当箇所）: 対象が gemini のときは拒否し、警告の通知を出す。文言は i18n に追加し「Gemini は model に effort が含まれる」の趣旨を短く（UI 文言ルール: 体言止め・簡潔）。Agent 省略時の共通値は「effort を持つ Agent（effortLevels が空でない）」だけで判定する
- 画面: `effortLevels` が空の Agent は effort を表示・編集させない
  - Web の Agent 設定・Agent ストリップの表示（「effort 既定」の行）、TUI の表示、input-assist の `/effort` 候補
- 保存済み設定（`.settings.json`）に gemini の `effort` が残っていても読み飛ばす（起動引数に使わない）。保存スキーマ自体は変えなくてよい
- テスト: antigravity-adapter（--effort が付かない）、input の `/effort gemini` 拒否、effortLevels が空のときの UI の分岐。既存テストの gemini の effort 前提を直す
- `docs/DESIGN.md`・`docs/spikes/antigravity.md` は更新済み。編集しない（矛盾を見つけたら QUESTION）

## Discretion

- UI で effort 行を隠す実装方法（行ごと消す・無効化しない）
- 文言の具体値とキー名
- 拒否の実装位置（入力の解釈か Coordinator か。既存の `/effort` の検証の流儀に合わせる）

## 編集してよいファイル

- `src/agents/agent-meta.ts`・`antigravity-adapter.ts` と各テスト
- `src/cli/input.ts`・`src/coordinator/`（/effort の検証の該当箇所）と各テスト
- `src/web/client/`（agent-settings・agent-strip・input-assist 等の該当箇所）・`src/tui/` と各テスト
- `src/i18n/messages.ts`
