// تم تكييف هذا الملف ليعمل كوظيفة سحابية (Serverless Function) على منصة Netlify
// بسم الله الرحمن الرحيم

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = 'cors');
const fs = require('fs');
const path = 'path');
const serverless = require('serverless-http'); // استيراد الحزمة الجديدة

const app = express();

// --- إعدادات المسارات والملفات ---
// في بيئة serverless، يجب تحديد المسار بشكل أكثر دقة
// نفترض أن مجلد 'data' موجود في جذر المشروع وليس بجانب الوظيفة
const DATA_FILE = path.resolve(process.cwd(), 'data', 'questions.json');
const DATA_DIR = path.dirname(DATA_FILE);

// --- إعدادات الوسيط (Middleware) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));

// إعداد الجلسات (Session)
// ملاحظة: الجلسات المعتمدة على الذاكرة قد لا تعمل بشكل متوقع في بيئة serverless
// لأن كل استدعاء للوظيفة قد يكون بيئة منفصلة. للاستخدام الفعلي، يفضل استخدام مخزن جلسات خارجي.
// لكن لإصلاح المشكلة الحالية، سنبقيها كما هي مع العلم بهذه الملاحظة.
app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' } // مهم لبيئة الإنتاج
}));

// كلمة المرور للمسؤول، يتم جلبها من متغيرات البيئة في لوحة تحكم Netlify
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Kjm#82@NwrA!2025').trim();

// --- دوال مساعدة لقراءة وكتابة الملفات ---
// التأكد من وجود مجلد البيانات والملف عند بدء التشغيل البارد للوظيفة
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function loadQuestions() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error("ERROR: Failed to load questions from data file.", err);
    return [];
  }
}

function saveQuestions(questions) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf8');
  } catch (err) {
    console.error("ERROR: Failed to save questions to data file.", err);
  }
}

// --- تعريف المسارات (API Routes) ---
// نستخدم Router لتقسيم المسارات بشكل منظم
const router = express.Router();

router.get('/', (req, res) => res.json({ message: 'API is running' }));

// مسارات المستخدمين (Public)
router.post('/questions', (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim() === '') {
    return res.status(400).json({ error: 'Question text required and cannot be empty' });
  }
  const questions = loadQuestions();
  const entry = {
    id: Date.now(),
    question: question.trim(),
    answer: '',
    date: new Date().toISOString()
  };
  questions.unshift(entry);
  saveQuestions(questions);
  res.status(201).json({ message: 'Question stored', entry });
});

router.get('/answered', (_req, res) => {
  const questions = loadQuestions().filter(q => q.answer).sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(questions);
});

// مسارات المسؤولين (Admin)
router.post('/admin/login', (req, res) => {
  const submittedPassword = (req.body.password || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ message: 'Logged in' });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// دالة وسيطة للتحقق من مصادقة المسؤول
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
};

router.get('/admin/questions', requireAuth, (req, res) => {
  res.json(loadQuestions());
});

router.post('/admin/answer', requireAuth, (req, res) => {
  const { id, answer } = req.body;
  if (!id || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ error: 'Invalid payload: ID and a non-empty answer are required.' });
  }
  const questions = loadQuestions();
  const index = questions.findIndex(q => q.id === Number(id));
  if (index === -1) {
    return res.status(404).json({ error: 'Question not found' });
  }
  questions[index].answer = answer.trim();
  saveQuestions(questions);
  res.json({ message: 'Answer saved' });
});

// استخدام المسارات مع بادئة '/.netlify/functions/api' التي ستتعامل معها Netlify
// لكن في الكود، نستخدم البادئة التي تناسب التوجيه من ملف netlify.toml
app.use('/', router); // تم تبسيط المسار هنا، سيعمل مع إعادة التوجيه

// --- التصدير النهائي للوظيفة ---
// هذا السطر هو مفتاح الحل، حيث يحول تطبيق Express إلى صيغة متوافقة مع Netlify Functions
module.exports.handler = serverless(app);
