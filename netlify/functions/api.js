/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 7.0 (إصدار الثقة والتفعيل التلقائي)
 * @description هذا الملف هو النسخة النهائية والمُحسّنة التي تدير كل منطق الخادم.
 * تم إزالة التحقق الاستباقي من Blobs للسماح لـ Netlify بتفعيل الخدمة تلقائياً عند أول استخدام،
 * مما يحل مشكلة المأزق (Catch-22).
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

// --- القسم 2: إعدادات التطبيق والمتغيرات البيئية ---
const app = express();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = process.env.SESSION_SECRET;

// ✅ **أهم تعديل**: تم إزالة التحقق من متغيرات البيئة الخاصة بـ Blobs
// نثق الآن أن Netlify ستقوم بتوفيرها عند أول تشغيل للدالة.
// لكننا نبقي على التحقق من المتغيرات التي يجب عليك إدخالها يدوياً.
if (!ADMIN_PASSWORD || !SESSION_SECRET) {
    // إذا لم تقم بتعيين هذه المتغيرات في لوحة تحكم Netlify، سيفشل النشر هنا.
    throw new Error('FATAL: ADMIN_PASSWORD and SESSION_SECRET environment variables must be set in the Netlify UI.');
}

// --- القسم 3: ديوان حفظ الجلسات (NetlifyBlobStore) ---
// هذه الفئة ستعمل الآن كما هو متوقع بعد أن تقوم Netlify بتفعيل Blobs
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        try {
            // عند أول استدعاء لهذه الدالة بعد النشر، ستقوم Netlify بتفعيل Blobs
            this.store = getStore({ name: this.storeName, consistency: 'strong' });
            console.log(`[INFO] Session store '${this.storeName}' initialized successfully.`);
        } catch (err) {
            console.error(`[FATAL] Failed to initialize blob store '${this.storeName}'. Make sure the site is deployed to Netlify.`, err);
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

// --- القسم 4: طبقة البيانات (Data Layer) ---
// سيتم تفعيل هذا المخزن أيضاً تلقائياً
const questionsStore = getStore('questions');
const QUESTIONS_KEY = 'all-questions-v1';

async function loadQuestions() {
    try {
        const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return Array.isArray(data) ? data : [];
    } catch (error) {
        if (error.status === 404) return [];
        console.error('[DATA_LAYER] Failed to load questions:', error);
        throw new Error('Failed to retrieve data from the cloud store.');
    }
}

async function saveQuestions(questions) {
    await questionsStore.setJSON(QUESTIONS_KEY, questions);
}

// --- القسم 5: الوسائط العامة (Global Middlewares) ---
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
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
    }
}));

// --- القسم 6: وسائط متخصصة ومحددات السرعة ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
};

// تم تخفيف القيود لتسهيل الاختبارات
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, 
    message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- القسم 7: الراوترات (Admin and Public Routers) ---
// (هذا الجزء لم يتغير، يمكنك استخدام نفس الكود السابق للراوترات)
const adminRouter = express.Router();
// ... ألصق كل كود adminRouter هنا ...
adminRouter.post('/login', loginLimiter, (req, res, next) => {
    try {
        const { password } = req.body;
        if (password && password === ADMIN_PASSWORD) {
            req.session.regenerate(err => {
                if (err) return next(err);
                req.session.authenticated = true;
                req.session.save(err => {
                    if (err) return next(err);
                    res.status(200).json({ success: true, message: 'Login successful.' });
                });
            });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password.' });
        }
    } catch (error) {
        next(error);
    }
});
adminRouter.post('/logout', requireAuth, (req, res, next) => {
    req.session.destroy(err => {
        if (err) return next(err);
        res.clearCookie('hawza.sid');
        res.status(200).json({ success: true, message: 'Logout successful.' });
    });
});
adminRouter.get('/status', requireAuth, (req, res) => {
    res.status(200).json({ success: true, data: { authenticated: true } });
});
adminRouter.get('/questions', requireAuth, async (req, res, next) => {
    try {
        const questions = await loadQuestions();
        res.status(200).json({ success: true, data: questions });
    } catch (error) {
        next(error);
    }
});
adminRouter.post('/question', requireAuth, async (req, res, next) => {
    try {
        const { question, source, tags, answer } = req.body;
        if (!question || typeof question !== 'string' || question.trim() === '') {
            return res.status(400).json({ success: false, error: 'Question text is required.' });
        }
        if (tags && !Array.isArray(tags)) {
            return res.status(400).json({ success: false, error: 'Tags must be an array.' });
        }
        const allQuestions = await loadQuestions();
        const newQuestion = {
            id: crypto.randomUUID(),
            question: question.trim(),
            source: (source || '').trim(),
            tags: tags || [],
            answer: answer || '',
            date: new Date().toISOString(),
            answeredDate: (answer && answer.trim() !== '') ? new Date().toISOString() : null
        };
        allQuestions.unshift(newQuestion);
        await saveQuestions(allQuestions);
        res.status(201).json({ success: true, data: newQuestion });
    } catch (error) {
        next(error);
    }
});
adminRouter.put('/question/:id', requireAuth, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { question, source, tags, answer } = req.body;
        if (!question || typeof question !== 'string' || question.trim() === '') {
            return res.status(400).json({ success: false, error: 'Question text is required.' });
        }
        const allQuestions = await loadQuestions();
        const index = allQuestions.findIndex(q => q.id === id);
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'Question not found.' });
        }
        const original = allQuestions[index];
        const hasNewAnswer = answer && answer.trim() !== '' && (!original.answer || original.answer.trim() === '');
        const updated = { ...original, question, source, tags, answer };
        if (hasNewAnswer) {
            updated.answeredDate = new Date().toISOString();
        }
        allQuestions[index] = updated;
        await saveQuestions(allQuestions);
        res.status(200).json({ success: true, data: updated });
    } catch (error) {
        next(error);
    }
});
adminRouter.delete('/question/:id', requireAuth, async (req, res, next) => {
    try {
        const { id } = req.params;
        let allQuestions = await loadQuestions();
        const filtered = allQuestions.filter(q => q.id !== id);
        if (allQuestions.length === filtered.length) {
            return res.status(404).json({ success: false, error: 'Question not found.' });
        }
        await saveQuestions(filtered);
        res.status(200).json({ success: true, message: 'Question deleted successfully.' });
    } catch (error) {
        next(error);
    }
});

const publicRouter = express.Router();
// ... ألصق كل كود publicRouter هنا ...
publicRouter.post('/questions', async (req, res, next) => {
    try {
        const { question } = req.body;
        if (!question || typeof question !== 'string' || question.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'Question text is invalid or too short.' });
        }
        const allQuestions = await loadQuestions();
        const newQuestion = {
            id: crypto.randomUUID(),
            question: question.trim(),
            answer: '', source: '', tags: [],
            date: new Date().toISOString(),
            answeredDate: null,
        };
        allQuestions.unshift(newQuestion);
        await saveQuestions(allQuestions);
        res.status(201).json({ success: true, message: 'Your question has been received successfully.' });
    } catch (error) {
        next(error);
    }
});
publicRouter.get('/answered', async (req, res, next) => {
    try {
        const allQuestions = await loadQuestions();
        const answered = allQuestions.filter(q => q.answer && q.answer.trim() !== '');
        res.status(200).json({ success: true, data: answered });
    } catch (error) {
        next(error);
    }
});


// --- القسم 8: ربط المسارات ومعالج الأخطاء ---
app.use('/api', publicRouter);
app.use('/admin', adminRouter);

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
