// 人が読む文章の言語（DESIGN.md §13 Language）
import { SEND_MESSAGE_TOOL } from "../agents/agent-adapter.js";

export const LANGUAGES = ["ja", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

// Agent への指示に使う言語名（指示の本体は英語）
const LANGUAGE_NAMES: Record<Language, string> = { ja: "Japanese", en: "English" };

export const detectLanguage = (locale: string = Intl.DateTimeFormat().resolvedOptions().locale): Language =>
  locale.toLowerCase().startsWith("ja") ? "ja" : "en";

export const languageDirective = (language: Language): string =>
  `Write everything the human may read in ${LANGUAGE_NAMES[language]}: the short plan before you start, ` +
  `progress notes while working, the final answer, and ${SEND_MESSAGE_TOOL} bodies. ` +
  "Keep code, identifiers, commands, and file paths as they are.";
