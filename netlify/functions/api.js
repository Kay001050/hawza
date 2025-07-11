/*
 * بسم الله الرحمن الرحيم
 * =================================================================
 * ديوان الواجهة البرمجية (API) لمشروع "نور الحوزة"
 * نسخة منقحة ومحصّنة مع تخزين سحابي دائم
 * =================================================================
 * هذا الملف هو العقل المدبر للنظام، ومثابة القلب النابض له، وهو مسؤول عن:
 * - استلام المسائل وحفظها بشكل آمن ودائم في المخزن السحابي (Netlify Blobs).
 * - تقديم الأرشيف العلمي والمسائل المجابة للزوار الكرام.
 * - توفير ديوان خاص وآمن لخدام المشروع لإدارة المسائل والإجابات.
 * * تمت إعادة هندسته وتحصينه لضمان سلامة البيانات، استمراريتها، وموثوقيتها.
 */

// --- القسم الأول: استيراد الأركان والمكتبات الأساسية ---
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = 'serverless-http';
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// ✅ استيراد جوهر التخزين السحابي من Netlify
const { getStore } = require('@netlify/blobs');

// --- القسم الثاني: الإعدادات والثوابت الراسخة ---
const app = express();
const router = express.Router();

// مفتاح الدخول لديوان الإدارة (يجب ضبطه كمتغير بيئة في Netlify)
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();
// مفتاح سر الجلسات (يجب أن يكون سلسلة طويلة وقوية في بيئة الإنتاج)
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment';

// ✅ اسم الخزانة العلمية (المخزن السحابي)
const STORE_NAME = 'questions';

// --- القسم الثالث: إعدادات الوسائط البرمجية (Middleware) ---
app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(express.json({ limit: '5mb' })); // زيادة الحد الأقصى لحجم الطلب لدعم محرر النصوص
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// إعداد نظام الجلسات مع سياسة ملفات تعريف ارتباط محكّمة
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    // ✅ تصويب: سياسة 'none' ضرورية للإنتاج لضمان عمل الجلسات عبر النطاقات
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
  }
}));

// درع الحماية من محاولات الدخول المتكررة
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- القسم الرابع: دوال الوصول إلى الخزانة العلمية (Data Access Helpers) ---

// ... (دوال loadQuestions و saveQuestions تبقى كما هي، فهي سليمة) ...
async function loadQuestions() {
    try {
        const store = getStore(STORE_NAME);
        const data = await store.get('all_questions', { type: 'json' });
        return data || [];
    } catch (error) {
        if (error.status === 404) { return []; }
        console.error("خطأ جلل عند قراءة البيانات من الخزانة السحابية:", error);
        return [];
    }
}
async function saveQuestions(questions) {
    try {
        const store = getStore(STORE_NAME);
        await store.setJSON('all_questions', questions);
    } catch (error) {
        console.error("خطأ جلل عند كتابة البيانات في الخزانة السحابية:", error);
        throw new Error('فشل الخادم في حفظ البيانات في الخزانة السحابية.');
    }
}


// --- القسم الخامس: دالة التحقق من هوية المسؤول ---
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

// --- القسم السادس: أبواب ومسارات الواجهة البرمجية (API Routes) ---

// ... (مسار /questions و /answered يبقيان كما هما) ...

// **ديوان الإدارة: المسارات الخاصة بالمسؤول**

// باب الدخول إلى ديوان الإدارة
router.post('/admin/login', loginLimiter, (req, res) => {
  const submittedPassword = (req.body.password || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    
    // ✅ تصويب: ضمان حفظ الجلسة قبل إرسال الرد، هذا هو الحل للخطأ الرئيسي.
    req.session.save(err => {
      if (err) {
        console.error("خطأ في حفظ الجلسة:", err);
        return res.status(500).json({ success: false, error: 'فشل الخادم في بدء الجلسة.' });
      }
      res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح. أهلاً بكم.' });
    });
  } else {
    res.status(401).json({ success: false, error: 'مفتاح الدخول غير صحيح.' });
  }
});

// ... (مسار /admin/logout و /admin/status يبقيان كما هما) ...

// ✅ تحسين وتوسيع: مسار تحديث المسألة (سؤال، جواب، مصدر)
router.put('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  // الآن نستقبل السؤال والجواب والمصدر
  const { question, answer, source } = req.body;

  // التحقق من وجود نص السؤال على الأقل
  if (!question || typeof question !== 'string' || question.trim() === '') {
    return res.status(400).json({ success: false, error: 'نص السؤال المحدث مطلوب.' });
  }

  try {
    const questions = await loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));

    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على المسألة المطلوبة.' });
    }
    
    // تحديث كافة الحقول المقدمة
    questions[questionIndex].question = question.trim();
    questions[questionIndex].answer = answer || ''; // الجواب يمكن أن يكون فارغاً
    questions[questionIndex].source = source || null; // المصدر اختياري
    questions[questionIndex].lastModified = new Date().toISOString();
    
    // إذا لم يكن هناك جواب من قبل وتمت إضافته الآن، نسجل تاريخ الإجابة
    if (answer && !questions[questionIndex].answeredDate) {
        questions[questionIndex].answeredDate = new Date().toISOString();
    }

    await saveQuestions(questions);
    res.status(200).json({ success: true, message: 'تم تحديث المسألة بنجاح.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث المسألة.' });
  }
});

// ... (بقية المسارات تبقى كما هي) ...

// --- القسم السابع: ربط الموجه بالتطبيق الرئيسي وتصدير الدالة السحابية ---
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);

