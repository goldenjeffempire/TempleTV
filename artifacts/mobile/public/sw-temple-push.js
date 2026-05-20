/* Temple TV — Web Push service worker */

const DEFAULT_ICON = "/icons/icon-192x192.png";
const DEFAULT_BADGE = "/icons/badge-72x72.png";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "Temple TV", body: "", icon: DEFAULT_ICON, badge: DEFAULT_BADGE, data: {} };
  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch {
      payload.body = event.data.text();
    }
  }

  const title = payload.title || "Temple TV";
  const options = {
    body: payload.body || "",
    icon: payload.icon || DEFAULT_ICON,
    badge: payload.badge || DEFAULT_BADGE,
    tag: "temple-tv-" + (payload.data?.type || "default"),
    renotify: true,
    data: payload.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: payload.data?.type === "live",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const type = data.type || "";

  let targetPath = "/";
  if (type === "new_video" || type === "new_sermon") {
    targetPath = "/(tabs)/library";
  } else if (data.url) {
    targetPath = data.url;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          void client.navigate(targetPath).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetPath);
      return undefined;
    }),
  );
});
