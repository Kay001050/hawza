/**
 * @file api.js - نقطة الدخول الخلفية لمشروع نور الحوزة
 * @version 3.0 (نسخة محصّنة ضد الأخطاء الشائعة)
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
        this.store = getStore({ name: this.storeName, consistency: 'strong' });
        console.log(`[INFO] ديوان حفظ الجلسات '${this.storeName}' تم تهيئته.`);
    }

    get(sid, callback) {
        this.store.get(sid, { type: 'json' })
            .then(data => callback(null, data))
            .catch(err => {
                if (err.status === 404) return callback(null, null); // ليس خطأ، الجلسة غير موجودة
                console.error(`[SESSION GET ERROR] sid: ${sid}`, err);
                callback(err);
            });
    }

    set(sid, session, callback) {
        const ttl = session.cookie.maxAge ? Math.round(session.cookie.maxAge / 1000) : 86400;
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
                if (err.status === 404) return callback(null); // ليس خطأ، تم حذفها مسبقاً
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
app.set('trust proxy', 1); // ضروري لبيئة Netlify
app.use(cors({ origin: true, credentials: true }));
app.use(helmet()); // يضيف طبقة حماية أمنية
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// إعداد نظام الجلسات
app.use(session({
  store: new NetlifyBlobStore({ storeName: 'user-sessions' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,      // يجب أن يكون true لأن Netlify يستخدم HTTPS
    httpOnly: true,    // يمنع الوصول للكوكيز من جهة العميل
    sameSite: 'none',  // ضروري للتعامل مع النطاقات المختلفة بين الواجهة والخلفية
    maxAge: 1000 * 60 * 60 * 8 // مدة صلاحية الجلسة: 8 ساعات
  }
}));

// محدد معدل الطلبات على مسار تسجيل الدخول للحماية من هجمات القوة الغاشمة
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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
        return questions || [];
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

// [PUBLIC] استقبال سؤال جديد من المستخدمين
router.post('/questions', async (req, res) => {
    // الكود الخاص بهذا المسار...
});

// [PUBLIC] جلب الأسئلة المجابة فقط للعرض في الصفحة العامة
router.get('/answered', async (_req, res) => {
    // الكود الخاص بهذا المسار...
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

    const passwordsMatch = (submittedPassword === ADMIN_PASSWORD);
    console.log(`[LOGIN DIAGNOSTIC] نتيجة مقارنة كلمة المرور: ${passwordsMatch ? 'ناجحة' : 'فاشلة'}`);

    if (passwordsMatch) {
        req.session.regenerate(err => {
            if (err) {
                console.error("[SESSION REGENERATE ERROR]", err);
                return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام الجلسات.' });
            }
            req.session.authenticated = true;
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
    // الكود الخاص بهذا المسار...
});

// [ADMIN] التحقق من حالة تسجيل الدخول
router.get('/admin/status', requireAuth, (req, res) => {
    res.status(200).json({ success: true, authenticated: true });
});

// [ADMIN] جلب كل الأسئلة للوحة التحكم
router.get('/admin/questions', requireAuth, async (req, res) => {
    // الكود الخاص بهذا المسار...
});

// [ADMIN] إضافة مسألة جديدة
router.post('/admin/question', requireAuth, async (req, res) => {
    // الكود الخاص بهذا المسار...
});

// [ADMIN] تحديث مسألة موجودة
router.put('/admin/question/:id', requireAuth, async (req, res) => {
    // الكود الخاص بهذا المسار...
});

// [ADMIN] حذف مسألة
router.delete('/admin/question/:id', requireAuth, async (req, res) => {
    // الكود الخاص بهذا المسار...
});

// --- 7. التصدير النهائي ---
// ربط المسارات بالمسار الأساسي لوظائف Netlify
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
