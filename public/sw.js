// Service worker of the phone page: shows the notifications the computer pushes and opens the agent on tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { /* an unreadable push still has to show something */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Athenas Agent', {
    body: data.body || '',
    // One notification per agent: a newer one replaces the older and alerts again.
    tag: data.session || 'athenas',
    renotify: true,
    icon: '/mobile-icon-192.png',
    badge: '/mobile-badge.png',
    vibrate: [200, 100, 200],
    data: { session: data.session || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const session = (event.notification.data && event.notification.data.session) || '';
  event.waitUntil((async () => {
    const [page] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (page) {
      await page.focus();
      if (session) page.postMessage({ type: 'open-agent', session });
      return;
    }
    await self.clients.openWindow(session ? `/#agent=${encodeURIComponent(session)}` : '/');
  })());
});
