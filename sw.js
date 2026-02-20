/**
 * @file Service Worker لمشروع نور الحوزة
 * @description يدير هذا الملف التخزين المؤقت للموارد، ويوفر تجربة استخدام دون اتصال بالإنترنت،
 * ويستخدم استراتيجيات تخزين ذكية لتحسين الأداء.
 * @version 2.0
 */

// اسم فريد للتخزين المؤقت. قم بتغيير الرقم عند تحديث الملفات المخزنة.
const CACHE_NAME = 'hawza-cache-v2';

// صفحة مخصصة للعرض عند عدم الاتصال بالإنترنت.
const OFFLINE_URL = '/offline.html';

// قائمة بالملفات الأساسية التي يجب تخزينها مسبقاً عند تثبيت الـ Service Worker.
const PRECACHE_ASSETS = [
  '/', // الصفحة الرئيسية
  '/index.html',
  '/about.html',
  '/masadir.html',
  '/faq.html',
  '/answered.html',
  OFFLINE_URL,
  '/Icon.png',
  '/favicon.ico',
  // --- إضافة موارد CDN الأساسية للتخزين المؤقت ---
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;900&family=Amiri:ital,wght@0,400;0,700;1,400;1,700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
  'https://cdn.quilljs.com/1.3.6/quill.snow.css'
];

/**
 * عند تثبيت الـ Service Worker، يتم فتح الـ cache وتخزين الملفات الأساسية.
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] تخزين الملفات الأساسية مسبقًا...');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting()) // تفعيل الـ SW الجديد فوراً
  );
});

/**
 * عند تفعيل الـ Service Worker، يتم حذف أي نسخ cache قديمة.
 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim()) // التحكم في الصفحات المفتوحة
  );
});

/**
 * يعترض طلبات الشبكة ويستجيب لها بناءً على استراتيجيات التخزين.
 */
self.addEventListener('fetch', event => {
  // تجاهل الطلبات التي ليست من نوع GET
  if (event.request.method !== 'GET') {
    return;
  }

  // استراتيجية خاصة بطلبات API (Network First)
  if (event.request.url.includes('/.netlify/functions/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'أنت غير متصل بالإنترنت حاليًا.' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503
        });
      })
    );
    return;
  }
  
  // استراتيجية خاصة بالصفحات (Cache First, fallback to Network, then Offline page)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          return response || fetch(event.request);
        })
        .catch(() => {
          // إذا فشل كل شيء، يتم عرض صفحة عدم الاتصال
          return caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // استراتيجية عامة للموارد الأخرى (مثل الصور والخطوط) - Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        // تحديث الـ cache في الخلفية
        const fetchPromise = fetch(event.request).then(networkResponse => {
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, networkResponse.clone());
          });
          return networkResponse;
        });

        // إرجاع النسخة المخزنة فوراً إذا كانت موجودة، أو انتظار الشبكة
        return cachedResponse || fetchPromise;
      })
  );
});
