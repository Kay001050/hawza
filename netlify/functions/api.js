// بسم الله الرحمن الرحيم
// تم تكييف هذا الملف ليعمل كوظيفة سحابية (Serverless Function) على منصة Netlify
// مع إصلاحات وتحسينات شاملة لضمان الاستقرار والأمان.

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors'); // ✅ تصحيح: تم استخدام require بشكل صحيح
const fs = require('fs');
const path = require('path'); // ✅ تصحيح: تم استخدام require بشكل صحيح
const serverless = require('serverless-http');

const app = express();
const router = express.Router(); // استخدام Router لتنظيم أفضل

// --- إعدادات المسارات والملفات ---
// في بيئة serverless، يجب تحديد المسار بشكل دقيق لضمان الوصول للملفات
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'questions.json');

// --- إعدادات الوسيط (Middleware) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// إعداد CORS للسماح بالطلبات من واجهة الموقع مع إرسال الكعكات (cookies) للمصادقة
app.use(cors({ origin: true, credentials: true }));

// إعداد الجلسات (Session)
// ملاحظة هامة: الجلسات المعتمدة على الذاكرة مؤقتة في بيئة serverless.
// لكل طلب قد يتم إنشاء نسخة جديدة من الوظيفة. للبيئات الإنتاجية ذات الحجم الكبير،
// يُنصح بشدة باستخدام مخزن جلسات خارجي (مثل Redis أو FaunaDB).
// الحل الحالي يعمل لكن الجلسات قد تنتهي أسرع من المتوقع.
app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // يجب أن يكون true في بيئة الإنتاج (HTTPS)
    httpOnly: true, // يمنع الوصول للكعكة من خلال جافاسكريبت في المتصفح لزيادة الأمان
    maxAge: 1000 * 60 * 60 * 24 // صلاحية الجلسة ليوم واحد
  }
}));

// كلمة المرور للمسؤول، يتم جلبها من متغيرات البيئة في لوحة تحكم Netlify
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Kjm#82@NwrA!2025').trim();

// --- دوال مساعدة لقراءة وكتابة الملفات مع التأكد من وجودها ---
function ensureDataFileExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }
}

function loadQuestions() {
  ensureDataFileExists();
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error("خطأ حرج: فشل في تحميل الأسئلة من ملف البيانات.", err);
    // في حالة الفشل، نرجع مصفوفة فارغة لمنع انهيار التطبيق
    return [];
  }
}

function saveQuestions(questions) {
  ensureDataFileExists();
  try {
    // الكتابة بشكل متزامن لضمان حفظ البيانات قبل انتهاء تنفيذ الوظيفة
    fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf8');
  } catch (err) {
    console.error("خطأ حرج: فشل في حفظ الأسئلة في ملف البيانات.", err);
  }
}

// --- دالة وسيطة للتحقق من مصادقة المسؤول (Authentication Middleware) ---
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'غير مصادق عليه. يرجى تسجيل الدخول.' });
};

// --- تعريف المسارات (API Routes) ---

// **مسارات المستخدمين العامة (Public Routes)**
router.get('/answered', (_req, res) => {
  const questions = loadQuestions().filter(q => q.answer).sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(questions);
});

router.post('/questions', (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({ error: 'نص السؤال مطلوب ويجب ألا يكون فارغاً أو قصيراً جداً.' });
  }
  const questions = loadQuestions();
  const newEntry = {
    id: Date.now(),
    question: question.trim(),
    answer: '',
    date: new Date().toISOString()
  };
  questions.unshift(newEntry);
  saveQuestions(questions);
  res.status(201).json({ message: 'تم استلام السؤال بنجاح. شكراً لكم.', entry: newEntry });
});

// **مسارات المسؤولين الخاصة (Admin Routes)**
router.post('/admin/login', (req, res) => {
  const submittedPassword = (req.body.password || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.status(200).json({ message: 'تم تسجيل الدخول بنجاح.' });
  }
  res.status(401).json({ error: 'كلمة المرور غير صحيحة.' });
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'فشل في تسجيل الخروج.' });
    }
    res.clearCookie('connect.sid'); // اسم الكعكة الافتراضي لـ express-session
    res.status(200).json({ message: 'تم تسجيل الخروج بنجاح.' });
  });
});

// 💡 تحسين: إضافة مسار للتحقق من حالة المصادقة
router.get('/admin/status', requireAuth, (req, res) => {
  // إذا وصل الطلب إلى هنا، فذاك يعني أن requireAuth قد نجح
  res.status(200).json({ authenticated: true, message: 'الجلسة لا تزال نشطة.' });
});

router.get('/admin/questions', requireAuth, (req, res) => {
  res.status(200).json(loadQuestions());
});

router.post('/admin/answer', requireAuth, (req, res) => {
  const { id, answer } = req.body;
  // تدقيق أكثر صرامة للبيانات المدخلة
  if (!id || !answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ error: 'بيانات غير صالحة: معرف السؤال ونص الإجابة مطلوبان.' });
  }
  const questions = loadQuestions();
  const questionIndex = questions.findIndex(q => q.id === Number(id));
  if (questionIndex === -1) {
    return res.status(404).json({ error: 'لم يتم العثور على السؤال المطلوب.' });
  }
  questions[questionIndex].answer = answer.trim();
  questions[questionIndex].answeredDate = new Date().toISOString(); // إضافة تاريخ الإجابة
  saveQuestions(questions);
  res.status(200).json({ message: 'تم حفظ الجواب بنجاح.' });
});


// --- ربط الـ Router بالتطبيق الرئيسي ---
// البادئة /.netlify/functions/api ستتم إدارتها بواسطة Netlify بناءً على ملف netlify.toml
// لذا، التطبيق نفسه لا يحتاج إلى معرفة هذه البادئة.
app.use('/', router); 

// --- التصدير النهائي للوظيفة لتعمل مع Netlify ---
module.exports.handler = serverless(app);
