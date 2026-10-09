import { expect, it } from "vitest";
import { ROLE_PRESET_NAMES, ROLE_PRESETS, matchingRolePreset } from "./role-presets.js";

it("3 つのプリセットに両言語と両 Agent の専用文章がある", () => {
  expect(ROLE_PRESET_NAMES).toEqual(["design-review", "codex-design", "implement-review"]);
  for (const name of ROLE_PRESET_NAMES) {
    for (const language of ["ja", "en"] as const) {
      expect(ROLE_PRESETS[name][language].claude.length).toBeGreaterThan(0);
      expect(ROLE_PRESETS[name][language].codex.length).toBeGreaterThan(0);
    }
  }
  expect(ROLE_PRESETS["codex-design"].ja.claude).toContain("実装とコミットを担当する");
  expect(ROLE_PRESETS["codex-design"].ja.codex).toContain("コミットはしない");
  expect(ROLE_PRESETS["codex-design"].en.claude).toContain("Own implementation and commits");
});

it("両 Agent の文章が完全一致するプリセットだけを返す", () => {
  for (const name of ROLE_PRESET_NAMES) {
    for (const language of ["ja", "en"] as const) {
      expect(matchingRolePreset(ROLE_PRESETS[name][language])).toBe(name);
    }
  }
  expect(matchingRolePreset({ claude: ROLE_PRESETS["design-review"].ja.claude })).toBeUndefined();
  expect(matchingRolePreset({
    claude: ROLE_PRESETS["design-review"].ja.claude,
    codex: ROLE_PRESETS["design-review"].en.codex,
  })).toBeUndefined();
});
