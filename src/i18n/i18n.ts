// 文言の取得（DESIGN.md §28 v0.3 i18n）。1 つのプロセスは 1 つの言語で動く（起動時に setLanguage）。
// 言語を決めるまで・テストでは en
import type { Language } from "../context/language.js";
import { en, ja, type MessageKey, type Messages } from "./messages.js";

export type MessageParams = Record<string, string | number>;

export const MESSAGES: Record<Language, Messages> = { en, ja };

let current: Messages = en;
let language: Language = "en";
export const getLanguage = (): Language => language;

export const setLanguage = (next: Language): void => {
  language = next;
  current = MESSAGES[next];
};

export const format = (template: string, params: MessageParams = {}): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

export const t = (key: MessageKey, params?: MessageParams): string => format(current[key], params);
