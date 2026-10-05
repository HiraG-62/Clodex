// 入力中の `@<path>` を project のファイルへの参照として扱う（DESIGN.md §28 v0.3 A）。
// 中身は埋め込まず、パスだけを本文の末尾に添える（§3.5 Context by Reference）
const FILE_REFERENCE_PATTERN = /(?:^|\s)@([^\s@]+)/g;
// 文末の句読点や閉じ括弧はパスに含めない
const TRAILING_PUNCTUATION = /[.,:;!?)\]}>'"、。，．：；！？）」』】]+$/;
export const REFERENCED_FILES_HEADER = "Referenced files:";

export const extractFileReferences = (text: string): string[] => {
  const paths = [...text.matchAll(FILE_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? "").replace(TRAILING_PUNCTUATION, "").replace(/\\/g, "/"))
    .filter(Boolean);
  return [...new Set(paths)];
};

// 存在するファイルだけを末尾に列挙する。無ければ本文をそのまま返す
export const appendFileReferences = (text: string, isProjectFile: (path: string) => boolean): string => {
  const files = extractFileReferences(text).filter(isProjectFile);
  if (!files.length) return text;
  return `${text}\n\n${REFERENCED_FILES_HEADER}\n${files.map((file) => `- ${file}`).join("\n")}`;
};
