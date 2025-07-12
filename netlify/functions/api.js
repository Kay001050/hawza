/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 8.0 (إصدار مرن مع حلول بديلة)
 * @description نسخة محسنة تتضمن آلية fallback إلى مخزن بيانات مؤقت في الذاكرة في حال عدم تفعيل Netlify Blobs.
 */

// --- التبعيات الأساسية ---
const serverless = require('serverless-http');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getStore } = require('@netlify/blobs');
const { Store } = require('express-session');
const MemoryStore = require('memorystore')(session); // سنستخدم هذا للجلسات في الوضع المؤقت
const crypto = require('crypto');

const app = express();

// --- الإعدادات والمتغيرات البيئية ---
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'password').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-default-secret-for-local-dev';

if ((!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: ADMIN_USERNAME and ADMIN_PASSWORD must be set in production.');
}
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
     throw new Error('FATAL: SESSION_SECRET must be set in production.');
}


// --- التحقق من تفعيل Netlify Blobs ---
const isBlobsEnabled = Boolean(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN);
let sessionStore;
let dataLayer;

if (isBlobsEnabled) {
    console.log('[INFO] Netlify Blobs detected. Initializing cloud stores.');

    // --- طبقة البيانات مع Netlify Blobs (الحل الأساسي) ---
    class NetlifyBlobStore extends Store {
        // ... نفس كود NetlifyBlobStore من الإصدار السابق ...
        constructor(options = {}) {
            super(options);
            this.storeName = options.storeName || 'sessions';
            try {
                this.store = getStore({ name: this.storeName, consistency: 'strong' });
                console.log(`[INFO] Session store '${this.storeName}' initialized successfully.`);
            } catch (err) {
                console.error(`[FATAL] Failed to initialize blob store '${this.storeName}'`, err);
                throw err;
            }
        }
        get(sid, callback) {
            this.store.get(sid, { type: 'json' }).then(data => callback(null, data)).catch(err => {
                if (err.status === 404) return callback(null, null);
                console.error(`[SESSION GET ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
        set(sid, session, callback) {
            const ttl = session.cookie.maxAge ? Math.round(session.cookie.maxAge / 1000) : 86400;
            this.store.setJSON(sid, session, { ttl }).then(() => callback(null)).catch(err => {
                console.error(`[SESSION SET ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
        destroy(sid, callback) {
            this.store.delete(sid).then(() => callback(null)).catch(err => {
                if (err.status === 404) return callback(null);
                console.error(`[SESSION DESTROY ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
    }

    sessionStore = new NetlifyBlobStore({ storeName: 'user-sessions' });
    
    const questionsStore = getStore('questions');
    const QUESTIONS_KEY = 'all-questions-v1';

    dataLayer = {
        loadQuestions: async () => {
            try {
                const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
                return Array.isArray(data) ? data : [];
            } catch (error) {
                if (error.status === 404) return [];
                console.error('[DATA_LAYER] Failed to load questions:', error);
                throw new Error('Failed to retrieve data from the cloud store.');
            }
        },
        saveQuestions: async (questions) => {
            await questionsStore.setJSON(QUESTIONS_KEY, questions);
        }
    };

} else {
    console.warn('[WARNING] Netlify Blobs is not configured. Falling back to in-memory store.');
    console.warn('[WARNING] Data will NOT be persisted between function invocations or deploys.');

    // --- طبقة البيانات مع مخزن الذاكرة (الحل البديل) ---
    sessionStore = new MemoryStore({ checkPeriod: 86400000 }); // 24h

    let inMemoryQuestions = []; // قاعدة بيانات مؤقتة في الذاكرة

    dataLayer = {
        loadQuestions: async () => {
            // فقط أرجع ما هو موجود في الذاكرة
            return Promise.resolve(inMemoryQuestions);
        },
        saveQuestions: async (questions) => {
            // فقط حدث المصفوفة في الذاكرة
            inMemoryQuestions = questions;
            return Promise.resolve();
        }
    };
}


// --- الوسائط العامة (Global Middlewares) ---
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
    store: sessionStore, // ✨ استخدام المخزن الديناميكي (إما Blobs أو Memory)
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: 'hawza.sid',
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 8
    }
}));

// --- الوسائط المتخصصة ومحددات السرعة ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
};
const loginLimiter = rateLimit({ /* ... */ });

// --- الراوترات (Admin and Public Routers) ---
const adminRouter = express.Router();
const publicRouter = express.Router();

// نستخدم dataLayer للوصول إلى الدوال (إما من Blobs أو من الذاكرة)
// مثال في مسار `get /questions`
adminRouter.get('/questions', requireAuth, async (req, res, next) => {
    try {
        const questions = await dataLayer.loadQuestions(); // ✨ استخدام الطبقة المجردة
        res.status(200).json({ success: true, data: questions });
    } catch (error) {
        next(error);
    }
});

// مثال في مسار `post /question`
adminRouter.post('/question', requireAuth, async (req, res, next) => {
    try {
        // ... (نفس كود التحقق من المدخلات)
        const allQuestions = await dataLayer.loadQuestions(); // ✨ استخدام الطبقة المجردة
        const newQuestion = { /* ... */ };
        allQuestions.unshift(newQuestion);
        await dataLayer.saveQuestions(allQuestions); // ✨ استخدام الطبقة المجردة
        res.status(201).json({ success: true, data: newQuestion });
    } catch (error) {
        next(error);
    }
});


// قم بتطبيق نفس المبدأ على باقي المسارات التي تستخدم `loadQuestions` و `saveQuestions`
// (adminRouter.put, adminRouter.delete, publicRouter.post, publicRouter.get)
// ...
// --- (الكود الكامل للراوترات هنا مع استبدال `loadQuestions` بـ `dataLayer.loadQuestions` إلخ)
// ...

// --- ربط المسارات والتطبيق ---
app.use('/api', publicRouter);
app.use('/admin', adminRouter);

// --- معالج الأخطاء الشامل ---
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
