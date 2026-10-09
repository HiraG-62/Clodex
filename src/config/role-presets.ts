import type { AgentId } from "../agents/agent-adapter.js";
import type { Language } from "../context/language.js";

export const ROLE_PRESET_NAMES = ["design-review", "codex-design", "implement-review"] as const;
export type RolePresetName = (typeof ROLE_PRESET_NAMES)[number];
type Roles = Record<AgentId, string>;

export const ROLE_PRESETS: Record<RolePresetName, Record<Language, Roles>> = {
  "design-review": {
    ja: {
      claude:
        "設計とレビュー、コミットを担当する。設計書を書いてから実装を codex に DELEGATE する。codex の実装は差分を確認し、テストと型チェックを通してからコミットする。数行で済む修正は自分で行ってよい。",
      codex:
        "実装を担当する。claude の DELEGATE に従ってテストとコードを書き、テストと型チェックを通してから RESULT で報告する。設計に迷ったら claude に QUESTION する。コミットはしない。",
    },
    en: {
      claude:
        "Own design, review, and commits. Write a spec, then DELEGATE the implementation to codex. Review codex's diff and commit after the tests and type checks pass. You may make fixes of a few lines yourself.",
      codex:
        "Own implementation. Follow claude's DELEGATE: write tests and code, and report with RESULT after the tests and type checks pass. Ask claude with QUESTION when the design is unclear. Do not commit.",
    },
  },
  "codex-design": {
    ja: {
      claude:
        "実装とコミットを担当する。codex の DELEGATE に従ってテストとコードを書き、テストと型チェックを通してから RESULT で報告する。codex の承認を受けてからコミットする。設計に迷ったら codex に QUESTION する。",
      codex:
        "設計とレビューを担当する。設計書を書いてから実装を claude に DELEGATE する。claude の実装は差分を確認し、問題が無ければ RESULT（approved）で承認する。コミットはしない。",
    },
    en: {
      claude:
        "Own implementation and commits. Follow codex's DELEGATE: write tests and code, and report with RESULT after the tests and type checks pass. Commit after codex approves. Ask codex with QUESTION when the design is unclear.",
      codex:
        "Own design and review. Write a spec, then DELEGATE the implementation to claude. Review claude's diff and approve with RESULT (approved) when it is fine. Do not commit.",
    },
  },
  "implement-review": {
    ja: {
      claude: "設計と実装、コミットを担当する。まとまった変更を終えたら、コミットの前に codex に REVIEW_REQUEST を送り、指摘を反映してからコミットする。",
      codex:
        "レビューを担当する。claude の REVIEW_REQUEST に対し、差分を読んで、バグ・設計の問題・テストの不足を RESULT の issues で報告する。コードは変更しない。",
    },
    en: {
      claude:
        "Own design, implementation, and commits. After a sizable change, send a REVIEW_REQUEST to codex before committing, and commit after addressing the findings.",
      codex:
        "Own reviews. For claude's REVIEW_REQUEST, read the diff and report bugs, design problems, and missing tests as RESULT issues. Do not change code.",
    },
  },
};

export const isRolePresetName = (name: string): name is RolePresetName => (ROLE_PRESET_NAMES as readonly string[]).includes(name);

export const matchingRolePreset = (roles: Partial<Roles>): RolePresetName | undefined => {
  for (const name of ROLE_PRESET_NAMES) {
    for (const language of ["ja", "en"] as const) {
      const preset = ROLE_PRESETS[name][language];
      if (roles.claude === preset.claude && roles.codex === preset.codex) return name;
    }
  }
  return undefined;
};
