// スマホへの通知の Service Worker（DESIGN.md §28 スマホへの通知（Web Push））。
// iOS は Push を受けて通知を出さないと購読を取り消すことがあるので、ここでは間引かずに必ず出す
export const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Clodex", { body: data.body || "", icon: "/apple-touch-icon.png" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) =>
    windows.length ? windows[0].focus() : self.clients.openWindow("/")));
});
`;
