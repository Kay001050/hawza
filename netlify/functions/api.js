/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 7.0 (إصدار مُعزّز، آمن، ومُطوّر)
 * @description هذا الملف هو النسخة النهائية والمُحسّنة التي تدير كل منطق الخادم.
 * يتضمن تحققًا استباقيًا من تفعيل Netlify Blobs، وهيكلية فائقة الوضوح،
 * وأمانًا مُعززًا بإضافة اسم مستخدم، ومعالجة شاملة للأخطاء.
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
const crypto = require('crypto'); // لاستخدام crypto.randomUUID()

// --- القسم 2: التحقق الاستباقي من البيئة ---
const isBlobsEnabled = Boolean(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN);

if (!isBlobsEnabled) {
    console.error('[FATAL] Netlify Blobs is not enabled for this site!');
    console.error('[FATAL] Please enable it in the Netlify dashboard under "Integrations" > "Blobs".');
    const maintenanceApp = express();
    maintenanceApp.use(cors());
    maintenanceApp.use((req, res) => {
        res.status(503).json({
            success: false,
            error: 'Service Unavailable: The backend data store (Netlify Blobs) is not configured. Please contact the site administrator.'
        });
    });
    module.exports.handler = serverless(maintenanceApp);
} else {
    // --- القسم 3: إعدادات التطبيق والمتغيرات البيئية ---
    const app = express();
    
    // ✨ جديد: إضافة اسم المستخدم وتحديث التحقق
    const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
    const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
    const SESSION_SECRET = process.env.SESSION_SECRET;

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
        throw new Error('FATAL: ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET environment variables must be set.');
    }

    // --- القسم 4: ديوان حفظ الجلسات (NetlifyBlobStore) - بدون تغيير ---
    class NetlifyBlobStore extends Store {
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

    // --- القسم 5: طبقة البيانات (Data Layer) - بدون تغيير ---
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

    // --- القسم 6: الوسائط العامة (Global Middlewares) - بدون تغيير ---
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

    // --- القسم 7: وسائط متخصصة ومحددات السرعة - بدون تغيير ---
    const requireAuth = (req, res, next) => {
        if (req.session && req.session.authenticated) {
            return next();
        }
        res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    };

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // --- القسم 8: الراوتر الخاص بالمسؤول (Admin Router) ---
    const adminRouter = express.Router();

    // ✨ تحديث: تعديل منطق تسجيل الدخول ليشمل اسم المستخدم
    adminRouter.post('/login', loginLimiter, (req, res, next) => {
        try {
            const { username, password } = req.body;
            // التحقق من اسم المستخدم وكلمة المرور
            if (username && password && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
                req.session.regenerate(err => {
                    if (err) return next(err);
                    req.session.authenticated = true;
                    req.session.username = username; // يمكن حفظ اسم المستخدم في الجلسة إذا أردنا
                    req.session.save(err => {
                        if (err) return next(err);
                        res.status(200).json({ success: true, message: 'Login successful.' });
                    });
                });
            } else {
                res.status(401).json({ success: false, error: 'Invalid username or password.' });
            }
        } catch (error) {
            next(error);
        }
    });

    // باقي مسارات المسؤول تبقى كما هي بدون تغيير جوهري
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
            const index = allQuestions.findIndex(q => q.id === id); // المقارنة تبقى كما هي (نص مع نص)
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
            const filtered = allQuestions.filter(q => q.id !== id); // المقارنة تبقى كما هي
            if (allQuestions.length === filtered.length) {
                return res.status(404).json({ success: false, error: 'Question not found.' });
            }
            await saveQuestions(filtered);
            res.status(200).json({ success: true, message: 'Question deleted successfully.' });
        } catch (error) {
            next(error);
        }
    });
    
    // --- القسم 9: الراوتر الخاص بالعامة (Public Router) - بدون تغيير ---
    const publicRouter = express.Router();
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

    // --- القسم 10: ربط المسارات والتطبيق - بدون تغيير ---
    app.use('/api', publicRouter);
    app.use('/admin', adminRouter);
    
    // --- القسم 11: معالج الأخطاء الشامل (Global Error Handler) - بدون تغيير ---
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
}
