# `/limits` コマンド

`docs/DESIGN.md` の §14「上限」、§9「Agent の設定の保存」、Internal command の表を更新済み。

## 変更

- `src/cli/commands.ts`: `/limits [<name> <n>|reset]` を足す（`/help`・Web UI の候補・Tab 補完は既存の仕組みで共有される）。名前の候補は `messages` / `reviews` / `delegations` / `depth` / `reset`
- `src/coordinator/budget-manager.ts`
  - 名前と `BudgetLimits` のキーの対応、値の範囲（1〜100）は定数にする
  - `setLimits(limits: BudgetLimits)` を足す。進行中の chain にも、次の判定から新しい上限を使う
  - 上限に達したときの、人に見せる `error` に `/limits <name> <n>` を添える（Agent への tool エラーの文言は今のまま）
- project 全体への反映: ProjectContext（`src/hub/project-context.ts`）が project の上限を持ち、その project のすべての会話の Coordinator の BudgetManager に配る。後から作られる会話の Coordinator にも同じ値を使う
- 保存: 既存の `.settings.json` に `limits`（変えた上限だけ。`Partial<BudgetLimits>`）を足す。読み込み時、範囲外・不明なキーは無視する
- 起動時の優先順位: 保存した値 > 設定ファイルの `limits` > `DEFAULT_LIMITS`。保存した値があれば、起動時の案内に `saved settings: limits messages 16` の形で出す
- 表示（i18n。UI 文言の方針どおり短く）
  - `/limits`: 4 行（例: `messages 16（既定 8）`、`reviews 3`）
  - 変更時: `limits: messages 16`
  - `reset`: `limits: 既定に戻した`
  - 不正な入力: 使い方

## テスト

- `BudgetManager.setLimits` で、進行中の chain が新しい上限で判定されること（上げたら通り、下げたら拒否）
- `/limits` の解析: 正常値、範囲外（0・101・小数・文字）、不明な名前、`reset`
- ProjectContext: 変更が既存と新規の会話の Coordinator の両方に効くこと。保存されること
- 起動時の優先順位（保存 > 設定ファイル > 既定）と、壊れた・範囲外の保存値を無視すること
- 上限に達したときの人向けの `error` に `/limits` が含まれること
