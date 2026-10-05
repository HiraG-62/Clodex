// Tauri のダイアログとブラウザの入力を同じ結果にする。clientMain へ注入する純関数。
export const chooseProjectPath = async (
  nativeDialog: (() => Promise<string | null>) | undefined,
  browserPrompt: () => string | null,
): Promise<string | undefined> => {
  const selected = nativeDialog ? await nativeDialog() : browserPrompt();
  return selected?.trim() || undefined;
};
