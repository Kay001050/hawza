/*
 * بسم الله الرحمن الرحيم
 * =================================================================
 * ملف الواجهة البرمجية (API) لمشروع "نور الحوزة" - نسخة مُحترفة ومُحصّنة
 * =================================================================
 * هذا الملف هو العقل المدبر للنظام، مسؤول عن:
 * - استلام الأسئلة من المستخدمين وحفظها.
 * - تقديم الأسئلة المجابة للزوار.
 * - توفير واجهة آمنة للمسؤولين لإدارة الأسئلة والإجابات.
 * - تمكين عمليات التعديل والحذف والبحث.
 * * تم بناؤه مع التركيز على الأمان، الصلابة، وسلامة البيانات.
 */

// --- القسم الأول: استيراد الوحدات والمكتبات الأساسية (Dependencies) ---
require('dotenv').config(); // لتحميل متغيرات البيئة من ملف .env (مفيد للتطوير المحلي)
const express = require('express');          // الإطار الأساسي لبناء الواجهة البرمجية
const session = require('express-session');  // لإدارة جلسات المستخدمين (لتسجيل دخول المسؤول)
const cors = require('cors');              // للسماح بالطلبات من نطاقات مختلفة (من واجهة الموقع)
const path = require('path');              // للتعامل مع مسارات الملفات والمجلدات
// --- استيراد Netlify Blobs بدلاً من fs ---
const { getBlob, setBlob } = require('@netlify/blobs');
const serverless = require('serverless-http'); // لتحويل تطبيق Express إلى وظيفة سحابية متوافقة مع Netlify

// --- حزم أمان إضافية (تم التأكد من وجودها في package.json) ---
const helmet = require('helmet'); // يضيف طبقة من الحماية عن طريق ضبط رؤوس HTTP المختلفة
const rateLimit = require('express-rate-limit'); // للحماية من هجمات القوة الغاشمة (Brute-force)

// --- القسم الثاني: الإعدادات والثوابت (Configuration & Constants) ---
const app = express();         // إنشاء نسخة من تطبيق Express
const router = express.Router(); // استخدام موجّه (Router) لتنظيم المسارات بشكل أفضل

// كلمة المرور للمسؤول (يجب ضبطها في متغيرات البيئة في Netlify)
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();

// سر الجلسة (يجب ضبطه كمتغير بيئة قوي وطويل جداً)
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment';

// --- القسم الثالث: إعدادات الوسيط (Middleware Configuration) ---

// 1. تفعيل CORS للسماح للواجهة الأمامية بالتواصل مع الواجهة البرمجية
app.use(cors({
  origin: true,     // يسمح بالطلبات من نفس المصدر الذي تم تحميل الصفحة منه
  credentials: true // يسمح بإرسال الكعكات (cookies) مع الطلبات، وهو ضروري للجلسات
}));

// 2. استخدام Helmet لضبط رؤوس HTTP الأمنية (الآن يعمل)
app.use(helmet());

// 3. تفعيل محلل JSON و URL-encoded للتعامل مع الطلبات القادمة
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. إعداد جلسات المستخدمين (express-session)
app.use(session({
  secret: SESSION_SECRET,
  resave: false, // لا تعيد حفظ الجلسة إذا لم تتغير
  saveUninitialized: false, // لا تنشئ جلسة حتى يتم تخزين شيء ما
  cookie: {
    secure: process.env.NODE_ENV === 'production', // يجب أن يكون true في بيئة الإنتاج (HTTPS)
    httpOnly: true,     // يمنع الوصول للكعكة من خلال جافاسكريبت في المتصفح (حماية من XSS)
    sameSite: 'lax',    // يوفر حماية ضد هجمات CSRF
    maxAge: 1000 * 60 * 60 * 8 // صلاحية الجلسة لـ 8 ساعات عمل
  }
}));

// 5. إعداد محدد المعدل (Rate Limiter) لمنع تخمين كلمة المرور (الآن يعمل)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // نافذة زمنية: 15 دقيقة
  max: 10, // الحد الأقصى: 10 محاولات تسجيل دخول لكل IP خلال النافذة الزمنية
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
  standardHeaders: true, // يرسل معلومات الحد في رؤوس `RateLimit-*`
  legacyHeaders: false, // يعطل رؤوس `X-RateLimit-*` القديمة
});

// --- القسم الرابع: دوال مساعدة لإدارة البيانات باستخدام Netlify Blobs ---

const BLOB_KEY = 'questions.json';

/**
 * @description يقرأ الأسئلة من Netlify Blobs.
 * @returns {Promise<Array>} - مصفوفة الأسئلة.
 */
async function loadQuestions() {
  try {
    const blob = await getBlob({ name: BLOB_KEY });
    if (!blob || !blob.body) return [];
    const text = await blob.text();
    return JSON.parse(text || '[]');
  } catch (error) {
    console.error("خطأ عند قراءة Blob:", error);
    return [];
  }
}

/**
 * @description يحفظ مصفوفة الأسئلة في Netlify Blobs.
 * @param {Array} questions - مصفوفة الأسئلة المراد حفظها.
 * @returns {Promise<boolean>} - true عند النجاح، false عند الفشل.
 */
async function saveQuestions(questions) {
  try {
    await setBlob({ name: BLOB_KEY, body: JSON.stringify(questions, null, 2), contentType: 'application/json' });
    return true;
  } catch (error) {
    console.error("خطأ عند كتابة Blob:", error);
    return false;
  }
}

// --- القسم الخامس: دوال وسيطة مخصصة (Custom Middleware) ---

/**
 * @description دالة وسيطة للتحقق من أن المسؤول قد قام بتسجيل الدخول.
 */
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next(); // إذا كانت الجلسة مصادق عليها، استمر للخطوة التالية
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

// --- القسم السادس: تعريف المسارات (API Routes) ---

// **الجزء الأول: المسارات العامة (Public Routes)**

router.post('/questions', async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب ويجب أن يكون ذا معنى.' });
  }

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

  if (await saveQuestions(questions)) {
    res.status(201).json({ success: true, message: 'تم استلام السؤال بنجاح. شكراً لكم.' });
  } else {
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ السؤال.' });
  }
});

router.get('/answered', async (_req, res) => {
  const questions = (await loadQuestions())
    .filter(q => q.answer)
    .sort((a, b) => new Date(b.answeredDate || b.date) - new Date(a.answeredDate || a.date));
  res.status(200).json(questions);
});

// **الجزء الثاني: المسارات الخاصة بالمسؤول (Admin Routes)**

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

router.get('/admin/questions', requireAuth, async (req, res) => {
  res.status(200).json(await loadQuestions());
});

router.post('/admin/answer', requireAuth, async (req, res) => {
  const { id, answer } = req.body;
  if (!id || !answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'معرف السؤال ونص الإجابة مطلوبان.' });
  }
  const questions = await loadQuestions();
  const questionIndex = questions.findIndex(q => q.id === Number(id));
  if (questionIndex === -1) {
    return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
  }
  questions[questionIndex].answer = answer.trim();
  questions[questionIndex].answeredDate = new Date().toISOString();

  if (await saveQuestions(questions)) {
    res.status(200).json({ success: true, message: 'تم حفظ الجواب بنجاح.' });
  } else {
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ الجواب.' });
  }
});

router.put('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { answer } = req.body;
  if (!answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'نص الإجابة المحدث مطلوب.' });
  }
  const questions = await loadQuestions();
  const questionIndex = questions.findIndex(q => q.id === Number(id));
  if (questionIndex === -1) {
    return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
  }
  questions[questionIndex].answer = answer.trim();
  questions[questionIndex].lastModified = new Date().toISOString();

  if (await saveQuestions(questions)) {
    res.status(200).json({ success: true, message: 'تم تحديث الجواب بنجاح.' });
  } else {
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث الجواب.' });
  }
});

router.delete('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  let questions = await loadQuestions();
  const initialLength = questions.length;
  questions = questions.filter(q => q.id !== Number(id));
  if (initialLength === questions.length) {
    return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب لحذفه.' });
  }

  if (await saveQuestions(questions)) {
    res.status(200).json({ success: true, message: 'تم حذف السؤال بنجاح.' });
  } else {
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حذف السؤال.' });
  }
});

// --- القسم السابع: ربط الموجه بالتطبيق الرئيسي وتصدير الوظيفة ---
app.use('/', router);

// تصدير التطبيق كدالة متوافقة مع Netlify Functions
module.exports.handler = serverless(app);
