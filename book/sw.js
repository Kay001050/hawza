/**
 * Service Worker — مكتبة نور الحوزة
 * نسخة متكاملة مخصصة لمكتبة نور الحوزة
 */

const CACHE_NAME    = 'noor-hawza-v2';
const STATIC_CACHE  = 'noor-static-v2';
const DYNAMIC_CACHE = 'noor-dynamic-v2';
const IMG_CACHE     = 'noor-images-v2';

/* ── الأصول الثابتة للتخزين المسبق ── */
const PRECACHE = [
  '/book/',
  '/book/index.html',
  '/book/manifest.json',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&family=Amiri:wght@400;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/fuse.js/7.0.0/fuse.min.js',
  '/book/icons/icon-192.png',
  '/book/icons/icon-512.png',
];

/* ── صفحة بدون إنترنت ── */
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#a07f3a">
<title>غير متصل | نور الحوزة</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Cairo',sans-serif;background:#0a1517;color:#f0ebe3;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;text-align:center;padding:32px;direction:rtl;gap:20px}
  img{width:120px;height:120px;border-radius:24px;opacity:.9}
  h1{font-size:1.5rem;font-weight:800;color:#c9a050}
  p{font-size:.95rem;color:#b8c4c5;max-width:340px;line-height:1.9}
  button{background:linear-gradient(135deg,#a07f3a,#1e6b54);color:#fff;
         border:none;border-radius:999px;padding:14px 36px;
         font-family:'Cairo',sans-serif;font-size:1rem;font-weight:700;cursor:pointer;margin-top:8px}
  button:active{opacity:.85}
</style>
</head>
<body>
  <img src="/book/icons/icon-192.png" alt="نور الحوزة" onerror="this.style.display='none'">
  <h1>📵 لا يوجد اتصال بالإنترنت</h1>
  <p>مكتبة نور الحوزة تحتاج اتصالاً بالإنترنت لتحميل الكتب من Google Drive.<br>تحقق من اتصالك وأعد المحاولة.</p>
  <button onclick="location.reload()">🔄 إعادة المحاولة</button>
</body>
</html>`;

/* ════════════════ INSTALL ════════════════ */
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      Promise.allSettled(PRECACHE.map(url =>
        cache.add(url).catch(() => {}) // فشل فردي لا يوقف الباقي
      ))
    )
  );
});

/* ════════════════ ACTIVATE ════════════════ */
self.addEventListener('activate', e => {
  const VALID = [STATIC_CACHE, DYNAMIC_CACHE, IMG_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !VALID.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ════════════════ FETCH ════════════════ */
self.addEventListener('fetch', e => {
  const { request: req } = e;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  /* Google APIs & Drive — Network Only (البيانات دائماً من الشبكة) */
  if (url.hostname === 'www.googleapis.com' ||
      url.hostname === 'drive.google.com' ||
      url.hostname === 'lh3.googleusercontent.com') {
    e.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: 'offline', files: [] }),
        { headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  /* الصور (أيقونات المكتبة) — Cache First */
  if (req.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|webp|svg|ico)$/i)) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) caches.open(IMG_CACHE).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  /* الخطوط & CDN — Stale While Revalidate */
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com' ||
      url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(req).then(cached => {
          const fresh = fetch(req).then(res => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
          return cached || fresh;
        })
      )
    );
    return;
  }

  /* الصفحة الرئيسية — Network First + Offline Fallback */
  if (url.pathname === '/book/' || url.pathname === '/book/index.html') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(STATIC_CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() =>
          caches.match(req).then(cached =>
            cached || new Response(OFFLINE_HTML, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            })
          )
        )
    );
    return;
  }

  /* الباقي — Stale While Revalidate */
  e.respondWith(
    caches.open(DYNAMIC_CACHE).then(cache =>
      cache.match(req).then(cached => {
        const fresh = fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached || new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }));
        return cached || fresh;
      })
    )
  );
});

/* ════════════════ PUSH NOTIFICATIONS ════════════════ */
self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'نور الحوزة', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'نور الحوزة 📚', {
      body: data.body || 'لديك إشعار جديد',
      icon: '/book/icons/icon-192.png',
      badge: '/book/icons/icon-72.png',
      image: data.image || '/book/icons/icon-512.png',
      dir: 'rtl',
      lang: 'ar',
      vibrate: [200, 100, 200],
      tag: 'noor-hawza',
      renotify: true,
      data: { url: data.url || '/book/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/book/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('/book/') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});

/* ════════════════ BACKGROUND SYNC ════════════════ */
self.addEventListener('sync', e => {
  if (e.tag === 'sync-favorites') {
    console.log('[SW] مزامنة المفضلة في الخلفية');
  }
});
