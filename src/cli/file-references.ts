// 入力中の `@<path>` をファイルへの参照として扱う（DESIGN.md §28 v0.3 A・C）。
// 中身は埋め込まず、パスだけを本文の末尾に添える（§3.5 Context by Reference）。画像は Agent に画像としても渡す
const FILE_REFERENCE_PATTERN = /(?:^|\s)@([^\s@]+)/g;
// 文末の句読点や閉じ括弧はパスに含めない
const TRAILING_PUNCTUATION = /[.,:;!?)\]}>'"、。，．：；！？）」』】]+$/;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
export const REFERENCED_FILES_HEADER = "Referenced files:";

export const extractFileReferences = (text: string): string[] => {
  const paths = [...text.matchAll(FILE_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? "").replace(TRAILING_PUNCTUATION, "").replace(/\\/g, "/"))
    .filter(Boolean);
  return [...new Set(paths)];
};

export const isImagePath = (path: string): boolean => IMAGE_EXTENSION.test(path);

// 見つかったファイルを末尾に列挙する。無ければ本文をそのまま返す
export const appendFileReferences = (text: string, files: readonly string[]): string => {
  if (!files.length) return text;
  return `${text}\n\n${REFERENCED_FILES_HEADER}\n${files.map((file) => `- ${file}`).join("\n")}`;
};

export interface ResolvedReferences {
  text: string;
  // Agent に画像として渡すファイル（実パス）
  images: string[];
}

// resolve: 読んでよいファイルなら実パス、そうでなければ undefined
export const resolveReferences = async (
  text: string, resolve: (path: string) => Promise<string | undefined>,
): Promise<ResolvedReferences> => {
  const found = (await Promise.all(extractFileReferences(text).map(async (path) => ({ path, real: await resolve(path) }))))
    .filter((entry): entry is { path: string; real: string } => entry.real !== undefined);
  return {
    text: appendFileReferences(text, found.map(({ path }) => path)),
    images: found.filter(({ real }) => isImagePath(real)).map(({ real }) => real),
  };
};
