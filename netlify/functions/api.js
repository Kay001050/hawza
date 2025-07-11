/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 6.0 (إصدار مُحصّن واحترافي)
 * @description هذا الملف هو النسخة النهائية والمُحسّنة التي تدير كل منطق الخادم.
 * يتضمن تحققًا استباقيًا من تفعيل Netlify Blobs، وهيكلية فائقة الوضوح،
 * وأمانًا مُعززًا، ومعالجة شاملة للأخطاء.
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

// --- القسم 2: التحقق الاستباقي من البيئة (أهم تحسين) ---
// نتحقق مما إذا كانت متغيرات البيئة الخاصة بـ Netlify Blobs موجودة.
// هذه المتغيرات تضاف تلقائيًا عند تفعيل Blobs في لوحة تحكم Netlify.
const isBlobsEnabled = Boolean(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN);

if (!isBlobsEnabled) {
    // إذا لم تكن Blobs مفعلة، نقوم بتصدير معالج (handler) بديل "وضع الصيانة".
    console.error('[FATAL] Netlify Blobs is not enabled for this site!');
    console.error('[FATAL] Please enable it in the Netlify dashboard under "Integrations" > "Blobs".');

    const maintenanceApp = express();
    maintenanceApp.use(cors()); // السماح بالطلبات من أي مصدر لعرض رسالة الخطأ
    maintenanceApp.use((req, res) => {
        res.status(503).json({
            success: false,
            error: 'Service Unavailable: The backend data store (Netlify Blobs) is not configured. Please contact the site administrator.'
        });
    });
    // تصدير المعالج البديل وإنهاء تحميل الملف
    module.exports.handler = serverless(maintenanceApp);

} else {
    // --- القسم 3: إعدادات التطبيق والمتغيرات البيئية ---
    const app = express();
    const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
    const SESSION_SECRET = process.env.SESSION_SECRET;

    // تحقق من وجود المتغيرات السرية الأساسية
    if (!ADMIN_PASSWORD || !SESSION_SECRET) {
        throw new Error('FATAL: ADMIN_PASSWORD and SESSION_SECRET environment variables must be set.');
    }

    // --- القسم 4: ديوان حفظ الجلسات (NetlifyBlobStore) - نسخة مُحسّنة ---
    /**
     * @class NetlifyBlobStore
     * @description فئة مخصصة لربط express-session مع Netlify Blobs.
     * @extends Store
     */
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
                if (err.status === 404) return callback(null, null); // جلسة غير موجودة
                console.error(`[SESSION GET ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
        set(sid, session, callback) {
            // استخدام مدة حياة الكوكي، أو يوم كامل كقيمة افتراضية
            const ttl = session.cookie.maxAge ? Math.round(session.cookie.maxAge / 1000) : 86400;
            this.store.setJSON(sid, session, { ttl }).then(() => callback(null)).catch(err => {
                console.error(`[SESSION SET ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
        destroy(sid, callback) {
            this.store.delete(sid).then(() => callback(null)).catch(err => {
                // إذا كان الملف محذوفًا بالفعل، فلا مشكلة
                if (err.status === 404) return callback(null);
                console.error(`[SESSION DESTROY ERROR] sid: ${sid}`, err);
                callback(err);
            });
        }
    }

    // --- القسم 5: طبقة البيانات (Data Layer) ---
    const questionsStore = getStore('questions');
    const QUESTIONS_KEY = 'all-questions-v1';

    /**
     * @description تحميل جميع الأسئلة من مخزن Blobs.
     * @returns {Promise<Array<Object>>} مصفوفة من كائنات الأسئلة.
     */
    async function loadQuestions() {
        try {
            const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
            return Array.isArray(data) ? data : []; // التأكد من أننا نرجع مصفوفة دائماً
        } catch (error) {
            if (error.status === 404) return []; // الملف غير موجود بعد، نرجع مصفوفة فارغة
            console.error('[DATA_LAYER] Failed to load questions:', error);
            throw new Error('Failed to retrieve data from the cloud store.');
        }
    }

    /**
     * @description حفظ مصفوفة الأسئلة بالكامل في مخزن Blobs.
     * @param {Array<Object>} questions - مصفوفة الأسئلة المحدثة.
     */
    async function saveQuestions(questions) {
        await questionsStore.setJSON(QUESTIONS_KEY, questions);
    }

    // --- القسم 6: الوسائط العامة (Global Middlewares) ---
    app.set('trust proxy', 1); // ضروري إذا كان التطبيق خلف بروكسي (مثل Netlify)
    app.use(helmet()); // إضافة رؤوس أمان أساسية
    app.use(cors({ origin: true, credentials: true })); // السماح بالطلبات من الواجهة الأمامية
    app.use(express.json({ limit: '5mb' })); // تحليل جسم الطلب كـ JSON
    app.use(session({
        store: new NetlifyBlobStore({ storeName: 'user-sessions' }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        name: 'hawza.sid', // اسم مخصص للكوكي
        cookie: {
            secure: true,       // إرسال الكوكي فقط عبر HTTPS
            httpOnly: true,     // منع الوصول للكوكي من خلال JS في المتصفح
            sameSite: 'none',   // ضروري للطلبات بين المواقع (cross-site) في بيئة التطوير والإنتاج
            maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
        }
    }));

    // --- القسم 7: وسائط متخصصة ومحددات السرعة ---
    /**
     * @description وسيط للتحقق من أن المستخدم مسجل دخوله.
     */
    const requireAuth = (req, res, next) => {
        if (req.session && req.session.authenticated) {
            return next();
        }
        res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    };

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 دقيقة
        max: 10, // 10 محاولات لكل IP
        message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // --- القسم 8: الراوتر الخاص بالمسؤول (Admin Router) ---
    const adminRouter = express.Router();

    adminRouter.post('/login', loginLimiter, (req, res, next) => {
        try {
            const { password } = req.body;
            if (password && password === ADMIN_PASSWORD) {
                // استخدام regenerate لمنع هجمات تثبيت الجلسة (session fixation)
                req.session.regenerate(err => {
                    if (err) return next(err);
                    req.session.authenticated = true;
                    // استخدام save لضمان حفظ الجلسة قبل إرسال الرد
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
            res.clearCookie('hawza.sid'); // مسح الكوكي من المتصفح
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
            // تحقق دقيق من المدخلات
            const { question, source, tags, answer } = req.body;
            if (!question || typeof question !== 'string' || question.trim() === '') {
                return res.status(400).json({ success: false, error: 'Question text is required.' });
            }
            if (tags && !Array.isArray(tags)) {
                return res.status(400).json({ success: false, error: 'Tags must be an array.' });
            }

            const allQuestions = await loadQuestions();
            const newQuestion = {
                id: crypto.randomUUID(), // استخدام UUID آمن
                question: question.trim(),
                source: (source || '').trim(),
                tags: tags || [],
                answer: answer || '',
                date: new Date().toISOString(),
                answeredDate: (answer && answer.trim() !== '') ? new Date().toISOString() : null
            };
            allQuestions.unshift(newQuestion); // إضافة الجديد في بداية المصفوفة
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
    
            // تحقق من المدخلات
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

    // --- القسم 9: الراوتر الخاص بالعامة (Public Router) ---
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

    // --- القسم 10: ربط المسارات بالتطبيق ---
    // ملف netlify.toml هو من يوجه الطلبات إلى هذه المسارات الجذرية
    app.use('/api', publicRouter); // يعالج /api/*
    app.use('/admin', adminRouter); // يعالج /admin/*
    
    // --- القسم 11: معالج الأخطاء الشامل (Global Error Handler) ---
    // هذا الوسيط سيلتقط أي خطأ يحدث في أي مسار بالأعلى
    app.use((err, req, res, next) => {
        console.error('--- GLOBAL ERROR HANDLER CAUGHT AN ERROR ---');
        console.error('Request Path:', req.path);
        console.error(err.stack); // طباعة الخطأ الكامل في سجلات Netlify للتشخيص
        res.status(500).json({
            success: false,
            error: 'An unexpected server error occurred. The administrators have been notified.'
        });
    });

    // --- التصدير النهائي ---
    module.exports.handler = serverless(app);
} // نهاية كتلة `else`
