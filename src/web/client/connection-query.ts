export function connectionQuery(guiVersion: string | undefined, pushId: string | undefined, visibility: DocumentVisibilityState): URLSearchParams {
  const query = new URLSearchParams();
  if (guiVersion) query.set("gui", guiVersion);
  if (pushId) {
    query.set("push", pushId);
    query.set("visible", visibility === "visible" ? "1" : "0");
  }
  return query;
}
