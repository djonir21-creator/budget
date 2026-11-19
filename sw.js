/*
 * Service worker: зберігає файли застосунку в пам'яті телефону, щоб він працював без інтернету.
 * Дані користувача сюди НЕ потрапляють — вони лише в localStorage на пристрої.
 * Після оновлення файлів застосунку збільште номер версії нижче.
 */
var CACHE = 'family-budget-v4';
var REMIND = 'family-budget-reminders'; // розклад платежів (пише app.js), не видаляємо
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'xlsx-lite.js',
  'guide.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== REMIND; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function () {
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});

// ---------- Нагадування про платежі ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function localDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function diffDays(a, b) {
  var da = new Date(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)), db = new Date(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}
function whenText(d) { return d < 0 ? 'прострочено' : d === 0 ? 'сьогодні' : d === 1 ? 'завтра' : 'через ' + d + ' дн.'; }

// Android (встановлений застосунок): браузер інколи будить службовий файл у фоні — тоді нагадуємо.
function checkReminders() {
  return caches.open(REMIND).then(function (c) {
    return c.match('reminders.json').then(function (r) { return r ? r.json() : null; }).then(function (cfg) {
      if (!cfg || cfg.remindDays < 0 || !cfg.items || !cfg.items.length) return;
      var t = localDay(new Date());
      return c.match('shown.json').then(function (r) { return r ? r.json() : {}; }).then(function (shown) {
        if (shown.date !== t) shown = { date: t, keys: [] };
        var jobs = [];
        cfg.items.forEach(function (x) {
          var d = diffDays(t, x.due);
          if (d > cfg.remindDays || d < -3 || shown.keys.indexOf(x.key) >= 0) return;
          shown.keys.push(x.key);
          jobs.push(self.registration.showNotification(x.title, {
            body: x.name ? x.name + ', ' + whenText(d) : 'Платіж ' + whenText(d) + '. Відкрийте застосунок.',
            tag: 'pay-' + x.key, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png'
          }));
        });
        jobs.push(c.put('shown.json', new Response(JSON.stringify(shown))));
        return Promise.all(jobs);
      });
    });
  }).catch(function () { });
}

self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'payment-reminders') e.waitUntil(checkReminders());
});

// Натиснули на сповіщення — відкриваємо застосунок
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow('./');
  }));
});
