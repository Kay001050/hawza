/*
 * بسم الله الرحمن الرحيم
 * =================================================================
 * ملف الواجهة البرمجية (API) لمشروع "نور الحوزة" - نسخة مُرقّاة مع تخزين سحابي دائم
 * =================================================================
 * هذا الملف هو العقل المدبر للنظام، مسؤول عن:
 * - استلام الأسئلة وحفظها بشكل دائم في مخزن سحابي (Netlify Blobs).
 * - تقديم الأسئلة المجابة للزوار.
 * - توفير واجهة آمنة للمسؤولين لإدارة الأسئلة والإجابات.
 * * تم إعادة هندسته لضمان سلامة البيانات واستمراريتها.
 */

// --- القسم الأول: استيراد الوحدات والمكتبات الأساسية ---
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// ✅ استيراد مكتبة التخزين السحابي من نيتليفاي
const { getStore } = require('@netlify/blobs');

// --- القسم الثاني: الإعدادات والثوابت ---
const app = express();
const router = express.Router();

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment';

// اسم مخزن البيانات (المكتبة)
const STORE_NAME = 'questions';

// --- القسم الثالث: إعدادات الوسيط (Middleware Configuration) ---
app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- القسم الرابع: دوال مساعدة جديدة لإدارة البيانات من المخزن السحابي ---

/**
 * @description يقرأ جميع الأسئلة من مخزن Netlify Blobs.
 * @returns {Promise<Array>} - مصفوفة الأسئلة.
 */
async function loadQuestions() {
  try {
    const store = getStore(STORE_NAME);
    // جلب البيانات من المخزن، وفي حال كان فارغاً، نرجع مصفوفة فارغة
    const data = await store.get('all_questions', { type: 'json' });
    return data || [];
  } catch (error) {
    // إذا كان الخطأ هو "Not Found"، فهذا يعني أن المخزن لم يُنشأ بعد، وهذا طبيعي في المرة الأولى
    if (error.status === 404) {
      return [];
    }
    console.error("خطأ حرج عند قراءة البيانات من المخزن السحابي:", error);
    // في حالة أي خطأ آخر، نرجع مصفوفة فارغة لمنع انهيار النظام
    return [];
  }
}

/**
 * @description يحفظ مصفوفة الأسئلة الكاملة في مخزن Netlify Blobs.
 * @param {Array} questions - مصفوفة الأسئلة المراد حفظها.
 * @returns {Promise<boolean>} - true عند النجاح.
 */
async function saveQuestions(questions) {
  try {
    const store = getStore(STORE_NAME);
    // استخدام setJSON لحفظ المصفوفة بأكملها تحت مفتاح واحد
    await store.setJSON('all_questions', questions);
    return true;
  } catch (error) {
    console.error("خطأ حرج عند كتابة البيانات في المخزن السحابي:", error);
    throw new Error('فشل الخادم في حفظ البيانات في المخزن السحابي.');
  }
}

// --- القسم الخامس: دوال وسيطة مخصصة (لا تغيير هنا) ---
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

// --- القسم السادس: تعريف المسارات (API Routes) - تم تحويلها لدعم العمليات غير المتزامنة ---

// مسار لإرسال سؤال جديد (الآن async)
router.post('/questions', async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب ويجب أن يكون ذا معنى.' });
  }

  try {
    const questions = await loadQuestions();
    const newEntry = {
      id: Date.now(),
      question: question.trim(),
      answer: '',
      date: new Date().toISOString(),
      answeredDate: null,
      lastModified: null
    };
    questions.unshift(newEntry);
    
    await saveQuestions(questions);
    res.status(201).json({ success: true, message: 'تم استلام السؤال بنجاح وحفظه في السجل الدائم. شكراً لكم.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message || 'حدث خطأ في الخادم أثناء حفظ السؤال.' });
  }
});

// مسار لجلب الأسئلة المجابة فقط (الآن async)
router.get('/answered', async (_req, res) => {
  try {
    const questions = await loadQuestions();
    const answered = questions
      .filter(q => q.answer)
      .sort((a, b) => new Date(b.answeredDate || b.date) - new Date(a.answeredDate || a.date));
    res.status(200).json(answered);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب الأرشيف.' });
  }
});


// **الجزء الثاني: المسارات الخاصة بالمسؤول (Admin Routes) - تم تحويلها لـ async**

router.post('/admin/login', loginLimiter, (req, res) => {
  const submittedPassword = (req.body.password || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
  }
  res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
});

router.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false, error: 'فشل في إنهاء الجلسة.' });
    }
    res.clearCookie('connect.sid');
    res.status(200).json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
  });
});

router.get('/admin/status', requireAuth, (req, res) => {
  res.status(200).json({ success: true, authenticated: true });
});

// مسار جلب جميع الأسئلة (الآن async)
router.get('/admin/questions', requireAuth, async (req, res) => {
    try {
        const questions = await loadQuestions();
        res.status(200).json(questions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب جميع الأسئلة.' });
    }
});

// ✅ مسار جديد لإنشاء سؤال من قبل المسؤول (تمت إضافته هنا)
router.post('/admin/question', requireAuth, async (req, res) => {
  const { question, source } = req.body;
  
  // التحقق من صحة المدخلات
  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب ويجب أن يكون ذا معنى.' });
  }

  try {
    const questions = await loadQuestions(); // استخدام الدالة المحسّنة التي تتصل بـ Netlify Blobs
    const newEntry = {
      id: Date.now(),
      question: question.trim(),
      source: source ? source.trim() : null, // إضافة المصدر إن وجد
      answer: '', // السؤال الجديد يكون غير مجاب
      date: new Date().toISOString(),
      answeredDate: null,
      lastModified: null,
      addedBy: 'admin' // علامة لتمييز أن السؤال أضافه المسؤول
    };
    
    questions.unshift(newEntry); // إضافة السؤال الجديد في بداية القائمة
    
    await saveQuestions(questions); // الحفظ في المخزن السحابي
    
    res.status(201).json({ success: true, message: 'تم إنشاء السؤال بنجاح.', question: newEntry });
  } catch (error) {
    console.error('خطأ في إنشاء سؤال جديد:', error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إنشاء السؤال.' });
  }
});

// مسار إضافة إجابة (الآن async)
router.post('/admin/answer', requireAuth, async (req, res) => {
  const { id, answer } = req.body;
  if (!id || !answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'معرف السؤال ونص الإجابة مطلوبان.' });
  }
  
  try {
    const questions = await loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));
    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
    }
    questions[questionIndex].answer = answer.trim();
    questions[questionIndex].answeredDate = new Date().toISOString();
    
    await saveQuestions(questions);
    res.status(200).json({ success: true, message: 'تم حفظ الجواب بنجاح.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ الجواب.' });
  }
});

// مسار تحديث إجابة (الآن async)
router.put('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { answer } = req.body;
  if (!answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'نص الإجابة المحدث مطلوب.' });
  }

  try {
    const questions = await loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));
    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
    }
    questions[questionIndex].answer = answer.trim();
    questions[questionIndex].lastModified = new Date().toISOString();
    
    await saveQuestions(questions);
    res.status(200).json({ success: true, message: 'تم تحديث الجواب بنجاح.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث الجواب.' });
  }
});

// مسار حذف سؤال (الآن async)
router.delete('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    let questions = await loadQuestions();
    const initialLength = questions.length;
    questions = questions.filter(q => q.id !== Number(id));
    if (initialLength === questions.length) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب لحذفه.' });
    }
    
    await saveQuestions(questions);
    res.status(200).json({ success: true, message: 'تم حذف السؤال بنجاح.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حذف السؤال.' });
  }
});

// --- القسم السابع: ربط الموجه بالتطبيق الرئيسي وتصدير الوظيفة ---
app.use('/', router); 

module.exports.handler = serverless(app);
