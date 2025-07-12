/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 8.0 (إصدار مرن، قابل للتشخيص، ومحصّن)
 * @description هذا الملف يدير منطق الخادم مع ميزة الكشف التلقائي عن البيئة.
 * يستخدم Netlify Blobs الحقيقية على الخادم، ويتحول تلقائياً إلى مخزن بيانات
 * مؤقت في الذاكرة عند التشغيل المحلي عبر `netlify dev`، مما يتيح التطوير السلس.
 */

// --- القسم 1: التبعيات الأساسية ---
const serverless = require('serverless-http');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getStore } = require('@netlify/blobs');
const { Store } = require('express-session');
const crypto = require('crypto');

// --- القسم 2: تعريف البيئة والمخزن البديل ---

// ✨ جديد: مخزن بيانات بديل يعمل في الذاكرة للتطوير المحلي
class InMemoryBlobStore {
    constructor(name) {
        this.name = name;
        this.data = new Map();
        console.log(`[INFO] Using In-Memory fallback store for '${name}'.`);
    }
    async get(key, options = {}) {
        const entry = this.data.get(key);
        if (!entry) return null;
        if (options.type === 'json') {
            return JSON.parse(entry.value);
        }
        return entry.value;
    }
    async set(key, value) {
        this.data.set(key, { value, metadata: {} });
    }
    async setJSON(key, value) {
        this.data.set(key, { value: JSON.stringify(value), metadata: {} });
    }
    async delete(key) {
        this.data.delete(key);
    }
}

// ✨ جديد: الكشف عن بيئة التشغيل
const IS_LOCAL_DEV = process.env.NETLIFY_DEV === 'true';
const IS_BLOBS_CONFIGURED = Boolean(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN);

let storeFactory;

if (IS_LOCAL_DEV) {
    console.log('[INFO] Running in local development mode (Netlify Dev).');
    // في الوضع المحلي، نستخدم المخزن البديل دائماً
    storeFactory = (name) => new InMemoryBlobStore(name);
} else if (IS_BLOBS_CONFIGURED) {
    console.log('[INFO] Running on Netlify with Blobs configured.');
    // على الخادم مع تهيئة سليمة، نستخدم Netlify Blobs
    storeFactory = (name, config) => getStore({ name, ...config });
} else {
    // على الخادم ولكن التهيئة فاشلة، هذا هو مصدر الخطأ الأصلي
    console.error('[FATAL] Netlify Blobs is not configured for this site on the server!');
    console.error('[FATAL] Please link the project via `netlify link` and redeploy.');
    const maintenanceApp = express();
    maintenanceApp.use(cors());
    maintenanceApp.use((req, res) => {
        res.status(503).json({
            success: false,
            error: 'Service Unavailable: The backend data store (Netlify Blobs) is not configured. Please contact the site administrator to link the repository.'
        });
    });
    // تصدير التطبيق المعطّل فوراً
    module.exports.handler = serverless(maintenanceApp);
    // نوقف تنفيذ باقي الملف
    return;
}

// --- القسم 3: إعدادات التطبيق والمتغيرات الأساسية ---
const app = express();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'password').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret-for-local-dev';

if (SESSION_SECRET === 'default-secret-for-local-dev' && !IS_LOCAL_DEV) {
    throw new Error('FATAL: SESSION_SECRET environment variable must be set in production.');
}

// --- القسم 4: ديوان حفظ الجلسات (NetlifyBlobStore) - الآن يستخدم storeFactory ---
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        try {
            // ✨ جديد: يستخدم الدالة المناسبة حسب البيئة
            this.store = storeFactory(this.storeName, { consistency: 'strong' });
            console.log(`[INFO] Session store '${this.storeName}' initialized successfully.`);
        } catch (err) {
            console.error(`[FATAL] Failed to initialize blob store '${this.storeName}'`, err);
            throw err;
        }
    }
    get(sid, callback) { /* ... الكود يبقى كما هو ... */ }
    set(sid, session, callback) { /* ... الكود يبقى كما هو ... */ }
    destroy(sid, callback) { /* ... الكود يبقى كما هو ... */ }
}
// (الكود الكامل لـ get/set/destroy موجود في ملفك الأصلي، سأقوم بنسخه هنا للاكتمال)
NetlifyBlobStore.prototype.get = function(sid, callback) {
    this.store.get(sid, { type: 'json' }).then(data => callback(null, data)).catch(err => {
        if (err && err.status === 404) return callback(null, null);
        console.error(`[SESSION GET ERROR] sid: ${sid}`, err);
        callback(err || new Error('Session get error'));
    });
};
NetlifyBlobStore.prototype.set = function(sid, session, callback) {
    const ttl = session.cookie.maxAge ? Math.round(session.cookie.maxAge / 1000) : 86400;
    this.store.setJSON(sid, session, { ttl }).then(() => callback(null)).catch(err => {
        console.error(`[SESSION SET ERROR] sid: ${sid}`, err);
        callback(err || new Error('Session set error'));
    });
};
NetlifyBlobStore.prototype.destroy = function(sid, callback) {
    this.store.delete(sid).then(() => callback(null)).catch(err => {
        if (err && err.status === 404) return callback(null);
        console.error(`[SESSION DESTROY ERROR] sid: ${sid}`, err);
        callback(err || new Error('Session destroy error'));
    });
};


// --- القسم 5: طبقة البيانات (Data Layer) - الآن تستخدم storeFactory ---
const questionsStore = storeFactory('questions'); // ✨ جديد
const QUESTIONS_KEY = 'all-questions-v1';

async function loadQuestions() {
    try {
        const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return Array.isArray(data) ? data : [];
    } catch (error) {
        if (error.status === 404) return [];
        console.error('[DATA_LAYER] Failed to load questions:', error);
        throw new Error('Failed to retrieve data from the data store.');
    }
}

async function saveQuestions(questions) {
    await questionsStore.setJSON(QUESTIONS_KEY, questions);
}

// --- بقية الأقسام (6 إلى 11) تبقى كما هي في الإصدار السابق ---
// ... (Global Middlewares, Specialized Middlewares, Routers, Error Handler)
// لا حاجة لتغيير منطق الـ routes أو express نفسه، التغيير الجوهري كان في كيفية
// تهيئة مخزن البيانات في البداية.

// --- القسم 6: الوسائط العامة (Global Middlewares) ---
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
    store: new NetlifyBlobStore({ storeName: 'user-sessions' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: 'hawza.sid',
    cookie: {
        secure: !IS_LOCAL_DEV, // ✨ آمن فقط في وضع الإنتاج
        httpOnly: true,
        sameSite: IS_LOCAL_DEV ? 'lax' : 'none', // ✨ `none` للإنتاج، `lax` للمحلي
        maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
    }
}));

// --- القسم 7: وسائط متخصصة ومحددات السرعة ---
const requireAuth = (req, res, next) => { /* ... بدون تغيير ... */ };
const loginLimiter = rateLimit({ /* ... بدون تغيير ... */ });
requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
};
loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});


// --- القسم 8: الراوتر الخاص بالمسؤول (Admin Router) ---
const adminRouter = express.Router();
adminRouter.post('/login', loginLimiter, (req, res, next) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.regenerate(err => {
            if (err) return next(err);
            req.session.authenticated = true;
            req.session.save(err => {
                if (err) return next(err);
                res.status(200).json({ success: true, message: 'Login successful.' });
            });
        });
    } else {
        res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }
});
// ... باقي مسارات المسؤول بدون تغيير ...
adminRouter.post('/logout', requireAuth, (req, res, next) => { /* ... */ });
adminRouter.get('/status', requireAuth, (req, res) => { /* ... */ });
adminRouter.get('/questions', requireAuth, async (req, res, next) => { /* ... */ });
adminRouter.post('/question', requireAuth, async (req, res, next) => { /* ... */ });
adminRouter.put('/question/:id', requireAuth, async (req, res, next) => { /* ... */ });
adminRouter.delete('/question/:id', requireAuth, async (req, res, next) => { /* ... */ });


// --- القسم 9: الراوتر الخاص بالعامة (Public Router) ---
const publicRouter = express.Router();
publicRouter.post('/questions', async (req, res, next) => { /* ... */ });
publicRouter.get('/answered', async (req, res, next) => { /* ... */ });

// --- القسم 10: ربط المسارات بالتطبيق ---
app.use('/api', publicRouter);
app.use('/admin', adminRouter);

// --- القسم 11: معالج الأخطاء الشامل (Global Error Handler) ---
app.use((err, req, res, next) => {
    console.error('--- GLOBAL ERROR HANDLER CAUGHT AN ERROR ---');
    console.error('Request Path:', req.path);
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'An unexpected server error occurred. The administrators have been notified.'
    });
});

// --- التصدير النهائي ---
module.exports.handler = serverless(app);