// ブラウザへ関数のまま埋め込むため、外部の値を参照しない。
export function isShellInput(text: string): boolean {
  return text.startsWith("!");
}
