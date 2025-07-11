/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 4.0 (نسخة محسّنة وشاملة مع إصلاح الأخطاء)
 * @description هذا الملف يدير كل منطق الخادم، بما في ذلك مصادقة المسؤول،
 * إدارة الجلسات، والتعامل مع البيانات عبر Netlify Blobs.
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

// --- 2. ديوان حفظ الجلسات (NetlifyBlobStore) ---
// وحدة مخصصة لتخزين جلسات المستخدمين بشكل دائم في Netlify Blobs
// مما يضمن بقاء تسجيل الدخول فعالاً في البيئة السحابية عديمة الحالة.
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        // تهيئة المخزن مع اتساق قوي لضمان قراءة آخر البيانات المكتوبة فوراً
        this.store = getStore({ name: this.storeName, consistency: 'strong' });
        console.log(`[INFO] ديوان حفظ الجلسات '${this.storeName}' تم تهيئته.`);
    }

    get(sid, callback) {
        this.store.get(sid, { type: 'json' })
            .then(data => callback(null, data))
            .catch(err => {
                // إذا لم يتم العثور على الجلسة (404)، فهذا ليس خطأ، بل يعني أن الجلسة غير موجودة.
                if (err.status === 404) return callback(null, null);
                console.error(`[SESSION GET ERROR] sid: ${sid}`, err);
                callback(err);
            });
    }

    set(sid, session, callback) {
        // تحديد مدة صلاحية الجلسة بالثواني، مع قيمة افتراضية ليوم واحد
        const ttl = session.cookie.maxAge ?
            Math.round(session.cookie.maxAge / 1000) : 86400; // 86400 ثانية = 24 ساعة
        this.store.setJSON(sid, session, { ttl })
            .then(() => callback(null))
            .catch(err => {
                console.error(`[SESSION SET ERROR] sid: ${sid}`, err);
                callback(err);
            });
    }

    destroy(sid, callback) {
        this.store.delete(sid)
            .then(() => callback(null))
            .catch(err => {
                // إذا كانت محذوفة مسبقاً (404)، فهذا ليس خطأ.
                if (err.status === 404) return callback(null);
                console.error(`[SESSION DESTROY ERROR] sid: ${sid}`, err);
                callback(err);
            });
    }
}

// --- 3. إعدادات التطبيق الرئيسية ---
const app = express();
const router = express.Router();

// تحميل المتغيرات البيئية الحساسة مع قيم افتراضية آمنة
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'default-pass').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret-key-that-is-long-and-secure';

// [DIAGNOSTIC] التحقق من تحميل المتغيرات عند بدء تشغيل الخادم
if (ADMIN_PASSWORD === 'default-pass' || SESSION_SECRET.startsWith('default-secret')) {
    console.warn("[SECURITY WARNING] يتم استخدام كلمة المرور أو مفتاح الجلسة الافتراضي. يجب تعيين متغيرات البيئة في إعدادات Netlify فوراً!");
}

// --- 4. الوسائط (Middlewares) ---
app.set('trust proxy', 1); // ضروري لبيئة Netlify للتعرف على البروكسي
app.use(cors({
    // السماح بالطلبات من مصدر الواجهة الأمامية فقط في البيئة الإنتاجية
    origin: process.env.NETLIFY_URL || true, // يسمح للجميع في التطوير المحلي
    credentials: true
}));
app.use(helmet()); // يضيف طبقة حماية أمنية عبر ضبط هيدرات HTTP
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// إعداد نظام الجلسات مع المخزن السحابي
app.use(session({
    store: new NetlifyBlobStore({ storeName: 'user-sessions' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: true,      // يجب أن يكون true لأن Netlify يستخدم HTTPS
        httpOnly: true,    // يمنع الوصول للكوكيز من جهة العميل عبر JavaScript
        sameSite: 'none',  // ضروري للتعامل مع النطاقات المختلفة بين الواجهة والخلفية
        maxAge: 1000 * 60 * 60 * 8 // مدة صلاحية الجلسة: 8 ساعات
    }
}));

// محدد معدل الطلبات على مسار تسجيل الدخول للحماية من هجمات القوة الغاشمة
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 10, // 10 محاولات لكل IP في غضون 15 دقيقة
    message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- 5. دوال مساعدة لإدارة البيانات مع Netlify Blobs ---
const questionsStore = getStore('questions');
const QUESTIONS_KEY = 'all-questions';

async function loadQuestions() {
    try {
        const questions = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return questions || []; // إذا كان المخزن فارغاً، أرجع مصفوفة فارغة
    } catch (error) {
        if (error.status === 404) return []; // الملف غير موجود بعد، أرجع مصفوفة فارغة
        console.error("[BLOBS LOAD ERROR]", error);
        throw new Error('فشل استرجاع البيانات من المخزن السحابي.');
    }
}

async function saveQuestions(questions) {
    try {
        await questionsStore.setJSON(QUESTIONS_KEY, questions);
    } catch (error) {
        console.error("[BLOBS SAVE ERROR]", error);
        throw new Error('فشل حفظ البيانات في المخزن السحابي.');
    }
}

// وسيط التحقق من المصادقة (Middleware)
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated === true) {
        return next(); // المستخدم مصادق عليه، استمر
    }
    res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

// --- 6. المسارات (API Routes) ---

// [PUBLIC] استقبال سؤال جديد من المستخدمين - ✅ تم تنفيذ المنطق بالكامل
router.post('/questions', async (req, res) => {
    try {
        const { question } = req.body;

        // التحقق من صحة المدخلات
        if (!question || typeof question !== 'string' || question.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'نص السؤال غير صالح أو قصير جداً. يرجى كتابة سؤال واضح.' });
        }

        const allQuestions = await loadQuestions();

        const newQuestion = {
            id: Date.now(), // استخدام التوقيت الحالي كمعرف فريد وبسيط
            question: question.trim(),
            answer: '', // الجواب يكون فارغاً بشكل افتراضي
            source: '',
            tags: [],
            date: new Date().toISOString(), // تاريخ الإضافة بصيغة ISO القياسية
            answeredDate: null,
        };

        // إضافة السؤال الجديد في بداية القائمة
        allQuestions.unshift(newQuestion);
        await saveQuestions(allQuestions);

        console.log(`[NEW QUESTION] تم استلام سؤال جديد بنجاح. ID: ${newQuestion.id}`);
        res.status(201).json({ success: true, message: 'تم استلام سؤالكم بنجاح.' });

    } catch (error) {
        console.error("[QUESTION SUBMIT ERROR]", error);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم. يرجى المحاولة لاحقاً.' });
    }
});

// [PUBLIC] جلب الأسئلة المجابة فقط للعرض في الصفحة العامة - ✅ تم تنفيذ المنطق بالكامل
router.get('/answered', async (_req, res) => {
    try {
        const allQuestions = await loadQuestions();
        // تصفية الأسئلة التي تحتوي على جواب غير فارغ
        const answeredQuestions = allQuestions.filter(q => q.answer && q.answer.trim() !== '');
        res.status(200).json(answeredQuestions);
    } catch (error) {
        console.error("[GET ANSWERED ERROR]", error);
        res.status(500).json({ success: false, error: 'فشل استرجاع قائمة الأسئلة المجابة.' });
    }
});

// === مسارات المسؤولين المحمية ===

// [ADMIN] مسار تسجيل دخول المسؤول
router.post('/admin/login', loginLimiter, (req, res) => {
    console.log('--- [LOGIN ATTEMPT] ---');
    const submittedPassword = (req.body.password || '').trim();

    if (!submittedPassword) {
        console.warn('[LOGIN FAILURE] تم تقديم كلمة مرور فارغة.');
        return res.status(400).json({ success: false, error: 'يجب تقديم كلمة مرور.' });
    }
    
    // مقارنة آمنة (على الرغم من أنها هنا مباشرة، في أنظمة حقيقية تستخدم bcrypt)
    const passwordsMatch = (submittedPassword === ADMIN_PASSWORD);
    
    // لغرض التشخيص فقط، لا تترك هذا الكود في البيئة النهائية إذا كانت كلمة المرور حساسة جداً
    console.log(`[LOGIN DIAGNOSTIC] Submitted: '${submittedPassword.substring(0, 3)}...', Env Var: '${ADMIN_PASSWORD.substring(0, 3)}...', Match: ${passwordsMatch}`);

    if (passwordsMatch) {
        // إعادة توليد الجلسة لمنع هجمات تثبيت الجلسة (Session Fixation)
        req.session.regenerate(err => {
            if (err) {
                console.error("[SESSION REGENERATE ERROR]", err);
                return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام الجلسات.' });
            }
            // تخزين حالة المصادقة في الجلسة الجديدة
            req.session.authenticated = true;
            
            // حفظ الجلسة بشكل صريح لضمان اكتمالها قبل إرسال الرد
            req.session.save(err2 => {
                if (err2) {
                    console.error("[SESSION SAVE ERROR]", err2);
                    return res.status(500).json({ success: false, error: 'خطأ داخلي في حفظ الجلسة.' });
                }
                console.log('[LOGIN SUCCESS] المصادقة تمت بنجاح والجلسة حُفظت.');
                res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
            });
        });
    } else {
        console.warn('[LOGIN FAILURE] كلمة المرور غير صحيحة.');
        res.status(401).json({ success: false, error: 'كلمة المرور المدخلة غير صحيحة.' });
    }
});

// [ADMIN] تسجيل خروج المسؤول
router.post('/admin/logout', requireAuth, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('[LOGOUT ERROR]', err);
            return res.status(500).json({ success: false, error: 'فشل تسجيل الخروج.' });
        }
        // مسح الكوكي من المتصفح
        res.clearCookie('connect.sid'); // اسم الكوكي الافتراضي لـ express-session
        console.log('[LOGOUT SUCCESS] تم تسجيل الخروج بنجاح.');
        res.status(200).json({ success: true, message: 'تم تسجيل الخروج.' });
    });
});

// [ADMIN] التحقق من حالة تسجيل الدخول
router.get('/admin/status', requireAuth, (req, res) => {
    res.status(200).json({ success: true, authenticated: true });
});

// [ADMIN] جلب كل الأسئلة للوحة التحكم
router.get('/admin/questions', requireAuth, async (req, res) => {
    try {
        const questions = await loadQuestions();
        res.status(200).json(questions);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// [ADMIN] إضافة مسألة جديدة
router.post('/admin/question', requireAuth, async (req, res) => {
    try {
        const { question, source, tags, answer } = req.body;
        if (!question || question.trim() === '') {
            return res.status(400).json({ success: false, error: 'نص المسألة مطلوب.' });
        }
        
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// [ADMIN] تحديث مسألة موجودة
router.put('/admin/question/:id', requireAuth, async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        const { question, source, tags, answer } = req.body;
        if (!question || question.trim() === '') {
            return res.status(400).json({ success: false, error: 'نص المسألة مطلوب.' });
        }

        const allQuestions = await loadQuestions();
        const questionIndex = allQuestions.findIndex(q => q.id === questionId);

        if (questionIndex === -1) {
            return res.status(404).json({ success: false, error: 'المسألة غير موجودة.' });
        }
        
        const originalQuestion = allQuestions[questionIndex];
        const updatedQuestion = {
            ...originalQuestion,
            question: question.trim(),
            source: (source || '').trim(),
            tags: tags || [],
            answer: answer || '',
            // تحديث تاريخ الإجابة فقط إذا تم إضافة جواب جديد
            answeredDate: (answer && answer.trim() !== '' && !originalQuestion.answer) ? new Date().toISOString() : originalQuestion.answeredDate
        };

        allQuestions[questionIndex] = updatedQuestion;
        await saveQuestions(allQuestions);
        res.status(200).json({ success: true, question: updatedQuestion });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// [ADMIN] حذف مسألة
router.delete('/admin/question/:id', requireAuth, async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        let allQuestions = await loadQuestions();
        const filteredQuestions = allQuestions.filter(q => q.id !== questionId);

        if (allQuestions.length === filteredQuestions.length) {
            return res.status(404).json({ success: false, error: 'المسألة غير موجودة.' });
        }

        await saveQuestions(filteredQuestions);
        res.status(200).json({ success: true, message: 'تم حذف المسألة بنجاح.' });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- 7. التصدير النهائي ---
// ربط المسارات بالمسار الأساسي لوظائف Netlify
// سيتم التعامل مع مسارات مثل `/.netlify/functions/api/admin/login`
app.use('/.netlify/functions/api', router);

// تصدير المعالج (handler) ليعمل مع Netlify Functions
module.exports.handler = serverless(app);

// ❌ تم حذف القوس الزائد الذي كان يسبب خطأ قاتلاً هنا.
