/**
 * Service Worker — مكتبة نور الحوزة
 * استراتيجية: Cache-First للأصول، Network-First للبيانات
 */

const CACHE_VERSION = 'noor-hawza-v1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const IMAGE_CACHE   = `${CACHE_VERSION}-images`;

/* ── الأصول الثابتة المُخزَّنة مسبقاً ── */
const PRECACHE_URLS = [
  '/book/',
  '/book/index.html',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&family=Amiri:wght@400;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/fuse.js/7.0.0/fuse.min.js',
];

/* ── صفحة Offline الاحتياطية ── */
const OFFLINE_PAGE = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#a07f3a">
<title>غير متصل | نور الحوزة</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Cairo',sans-serif;background:#f8f6f3;color:#1a1a1a;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;text-align:center;padding:24px;direction:rtl}
  .icon{font-size:5rem;margin-bottom:24px;opacity:.6}
  h1{font-size:1.6rem;font-weight:800;margin-bottom:12px;color:#a07f3a}
  p{font-size:1rem;color:#4a4a4a;max-width:360px;line-height:1.8;margin-bottom:28px}
  button{background:linear-gradient(135deg,#a07f3a,#1e6b54);color:#fff;
         border:none;border-radius:999px;padding:14px 32px;
         font-family:'Cairo',sans-serif;font-size:1rem;font-weight:700;
         cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
</style>
</head>
<body>
  <div class="icon">📚</div>
  <h1>أنت غير متصل بالإنترنت</h1>
  <p>تحتاج مكتبة نور الحوزة إلى اتصال بالإنترنت لتحميل الكتب والمحتوى.<br>يرجى التحقق من اتصالك والمحاولة مرة أخرى.</p>
  <button onclick="window.location.reload()">🔄 إعادة المحاولة</button>
</body>
</html>`;

/* ════════════════════════════════════════
   INSTALL — Pre-cache static assets
   ════════════════════════════════════════ */
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function(cache) {
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
        )
      );
    })
  );
});

/* ════════════════════════════════════════
   ACTIVATE — Clean old caches
   ════════════════════════════════════════ */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== IMAGE_CACHE)
            .map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

/* ════════════════════════════════════════
   FETCH — Routing Strategy
   ════════════════════════════════════════ */
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = new URL(req.url);

  /* فقط GET */
  if (req.method !== 'GET') return;

  /* Google Drive / APIs — Network Only */
  if (url.hostname === 'www.googleapis.com' || url.hostname === 'drive.google.com') {
    event.respondWith(networkOnly(req));
    return;
  }

  /* الصور — Cache First (مع Fallback) */
  if (req.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|webp|svg|ico|gif)$/i)) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  /* الخطوط وCSS وJS الخارجي — Stale While Revalidate */
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com' ||
      url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  /* الصفحة الرئيسية — Network First مع Offline Fallback */
  if (url.pathname === '/book/' || url.pathname === '/book/index.html') {
    event.respondWith(networkFirstWithOffline(req));
    return;
  }

  /* الباقي — Stale While Revalidate */
  event.respondWith(staleWhileRevalidate(req, DYNAMIC_CACHE));
});

/* ════════════════════════════════════════
   Strategies
   ════════════════════════════════════════ */

function cacheFirst(req, cacheName) {
  return caches.match(req).then(function(cached) {
    if (cached) return cached;
    return fetch(req).then(function(res) {
      if (res.ok) {
        var clone = res.clone();
        caches.open(cacheName).then(c => c.put(req, clone));
      }
      return res;
    }).catch(function() { return offlineFallback(req); });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then(function(cache) {
    return cache.match(req).then(function(cached) {
      var fetchPromise = fetch(req).then(function(res) {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function() { return cached || offlineFallback(req); });
      return cached || fetchPromise;
    });
  });
}

function networkFirstWithOffline(req) {
  return fetch(req).then(function(res) {
    if (res.ok) {
      caches.open(STATIC_CACHE).then(c => c.put(req, res.clone()));
    }
    return res;
  }).catch(function() {
    return caches.match(req).then(function(cached) {
      return cached || new Response(OFFLINE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    });
  });
}

function networkOnly(req) {
  return fetch(req).catch(function() {
    return new Response(JSON.stringify({ error: 'offline' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  });
}

function offlineFallback(req) {
  if (req.destination === 'document') {
    return new Response(OFFLINE_PAGE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  return new Response('', { status: 408, statusText: 'Offline' });
}

/* ════════════════════════════════════════
   Background Sync (future use)
   ════════════════════════════════════════ */
self.addEventListener('sync', function(event) {
  if (event.tag === 'sync-favorites') {
    console.log('[SW] Background sync: favorites');
  }
});

/* ════════════════════════════════════════
   Push Notifications (future use)
   ════════════════════════════════════════ */
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'نور الحوزة', {
      body: data.body || '',
      icon: '/book/icons/icon-192.png',
      badge: '/book/icons/icon-72.png',
      dir: 'rtl',
      lang: 'ar',
      tag: 'noor-hawza-notification',
      data: { url: data.url || '/book/' }
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/book/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (var c of clientList) {
        if (c.url === targetUrl && 'focus' in c) return c.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
