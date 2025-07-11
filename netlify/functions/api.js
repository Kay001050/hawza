/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 5.0 (نسخة نهائية مُحصّنة ومُعاد بناؤها)
 * @description هذا الملف يدير كل منطق الخادم بعد إعادة هيكلته لحل مشكلة 502 بشكل جذري.
 */

// --- 1. استيراد التبعيات الأساسية ---
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const { getStore } = require('@netlify/blobs');
const { Store } = require('express-session');

// --- 2. ديوان حفظ الجلسات (NetlifyBlobStore) - لا تغييرات هنا، الكود سليم ---
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        this.store = getStore({ name: this.storeName, consistency: 'strong' });
        console.log(`[INFO] ديوان حفظ الجلسات '${this.storeName}' تم تهيئته.`);
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

// --- 3. إعدادات التطبيق والمتغيرات البيئية ---
const app = express();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'default-pass').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret-key-that-is-long-and-secure';

// --- 4. الوسائط العامة (Global Middlewares) ---
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(session({
    store: new NetlifyBlobStore({ storeName: 'user-sessions' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 8
    }
}));

// --- 5. دوال مساعدة ووسائط متخصصة ---
const questionsStore = getStore('questions');
const QUESTIONS_KEY = 'all-questions';

async function loadQuestions() {
    try {
        const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return data || [];
    } catch (error) {
        if (error.status === 404) return [];
        throw new Error('فشل استرجاع البيانات من المخزن السحابي.');
    }
}

async function saveQuestions(questions) {
    await questionsStore.setJSON(QUESTIONS_KEY, questions);
}

const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
});

// --- 6. تعريف المسارات (Routers) ---

// 6.1) الراوتر الخاص بالمسؤول (Admin Router)
const adminRouter = express.Router();

adminRouter.post('/login', loginLimiter, (req, res, next) => {
    try {
        console.log('[ADMIN] /login route hit');
        const { password } = req.body;
        if (password && password.trim() === ADMIN_PASSWORD) {
            req.session.regenerate(err => {
                if (err) return next(err);
                req.session.authenticated = true;
                req.session.save(err => {
                    if (err) return next(err);
                    console.log('[ADMIN] Login successful');
                    res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
                });
            });
        } else {
            console.warn('[ADMIN] Invalid login attempt');
            res.status(401).json({ success: false, error: 'كلمة المرور المدخلة غير صحيحة.' });
        }
    } catch (error) {
        next(error);
    }
});

adminRouter.post('/logout', requireAuth, (req, res, next) => {
    req.session.destroy(err => {
        if (err) return next(err);
        res.clearCookie('connect.sid');
        res.status(200).json({ success: true, message: 'تم تسجيل الخروج.' });
    });
});

adminRouter.get('/status', requireAuth, (req, res) => {
    res.status(200).json({ success: true, authenticated: true });
});

adminRouter.get('/questions', requireAuth, async (req, res, next) => {
    try {
        const questions = await loadQuestions();
        res.status(200).json(questions);
    } catch (error) {
        next(error);
    }
});

adminRouter.post('/question', requireAuth, async (req, res, next) => {
    try {
        const { question, source, tags, answer } = req.body;
        if (!question || question.trim() === '') return res.status(400).json({ error: 'نص المسألة مطلوب.' });
        const allQuestions = await loadQuestions();
        const newQuestion = {
            id: Date.now(),
            question: question.trim(),
            source: (source || '').trim(),
            tags: tags || [],
            answer: answer || '',
            date: new Date().toISOString(),
            answeredDate: (answer && answer.trim() !== '') ? new Date().toISOString() : null
        };
        allQuestions.unshift(newQuestion);
        await saveQuestions(allQuestions);
        res.status(201).json({ success: true, question: newQuestion });
    } catch (error) {
        next(error);
    }
});

adminRouter.put('/question/:id', requireAuth, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { question, source, tags, answer } = req.body;
        const allQuestions = await loadQuestions();
        const index = allQuestions.findIndex(q => q.id === id);
        if (index === -1) return res.status(404).json({ error: 'المسألة غير موجودة.' });
        
        const original = allQuestions[index];
        const updated = { ...original, question, source, tags, answer };
        if (answer && !original.answer) {
            updated.answeredDate = new Date().toISOString();
        }
        allQuestions[index] = updated;
        await saveQuestions(allQuestions);
        res.status(200).json({ success: true, question: updated });
    } catch (error) {
        next(error);
    }
});

adminRouter.delete('/question/:id', requireAuth, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        let allQuestions = await loadQuestions();
        const filtered = allQuestions.filter(q => q.id !== id);
        if (allQuestions.length === filtered.length) return res.status(404).json({ error: 'المسألة غير موجودة.' });
        await saveQuestions(filtered);
        res.status(200).json({ success: true, message: 'تم حذف المسألة بنجاح.' });
    } catch (error) {
        next(error);
    }
});

// 6.2) الراوتر الخاص بالعامة (Public Router)
const publicRouter = express.Router();

publicRouter.post('/questions', async (req, res, next) => {
    try {
        console.log('[PUBLIC] /questions route hit');
        const { question } = req.body;
        if (!question || typeof question !== 'string' || question.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'نص السؤال غير صالح أو قصير جداً.' });
        }
        const allQuestions = await loadQuestions();
        const newQuestion = {
            id: Date.now(),
            question: question.trim(),
            answer: '',
            source: '',
            tags: [],
            date: new Date().toISOString(),
            answeredDate: null,
        };
        allQuestions.unshift(newQuestion);
        await saveQuestions(allQuestions);
        console.log('[PUBLIC] New question saved successfully.');
        res.status(201).json({ success: true, message: 'تم استلام سؤالكم بنجاح.' });
    } catch (error) {
        next(error);
    }
});

publicRouter.get('/answered', async (req, res, next) => {
    try {
        console.log('[PUBLIC] /answered route hit');
        const allQuestions = await loadQuestions();
        const answered = allQuestions.filter(q => q.answer && q.answer.trim() !== '');
        res.status(200).json(answered);
    } catch (error) {
        next(error);
    }
});

// --- 7. ربط المسارات بالتطبيق ---
// ✅ هذا هو الجزء الأهم في الإصلاح
// يتم ربط الراوترات بالمسارات الجذرية، وملف netlify.toml هو من يضيف البادئات
app.use('/api', publicRouter); // سيتعامل مع /api/questions و /api/answered
app.use('/admin', adminRouter); // سيتعامل مع /admin/login و /admin/questions

// --- 8. معالج الأخطاء الشامل (Global Error Handler) ---
// هذا الوسيط سيلتقط أي خطأ يحدث في أي مسار بالأعلى
app.use((err, req, res, next) => {
    console.error('--- GLOBAL ERROR HANDLER CAUGHT AN ERROR ---');
    console.error(err.stack); // طباعة الخطأ الكامل في سجلات Netlify للتشخيص
    res.status(500).json({
        success: false,
        error: 'حدث خطأ غير متوقع في الخادم. تم إبلاغ المسؤولين.'
    });
});

// --- 9. التصدير النهائي ---
// يتم تصدير التطبيق بالكامل ليتم تشغيله بواسطة Netlify
module.exports.handler = serverless(app);
