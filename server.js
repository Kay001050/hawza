require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // استدعاء مكتبة التشفير لإنشاء سر جلسة قوي

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. إعدادات الأمان والوسائط (Middleware) المحصّنة ---

// إعدادات CORS صارمة وآمنة: السماح فقط لخادمك بالتواصل
const corsOptions = {
  origin: `http://localhost:${PORT}`, // السماح فقط لهذا الأصل
  credentials: true, // السماح بإرسال كعكات الارتباط (Cookies)
};
app.use(cors(corsOptions));

// إعدادات جلسة آمنة ومناسبة للإنتاج
app.use(session({
  // استخدام سر قوي جداً يتم إنشاؤه تلقائياً إذا لم يكن موجوداً
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // يجب أن يكون true فقط عند استخدام HTTPS
    httpOnly: true, // منع الوصول للكعكة من خلال JavaScript في المتصفح
    sameSite: 'lax', // حماية ضد هجمات CSRF
    maxAge: 1000 * 60 * 60 * 24 // صلاحية الكعكة: يوم واحد
  }
}));

// استخدام body-parsers بعد إعدادات الأمان
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 2. إعدادات كلمة المرور والبيانات ---

const DATA_FILE = path.join(__dirname, 'data', 'questions.json');
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Kjm#82@NwrA!2025').trim();

// التأكد من وجود مجلد وملف البيانات
if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

// دوال مساعدة لقراءة وكتابة الأسئلة
function loadQuestions() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) { return []; }
}
function saveQuestions(questions) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf8');
}

// دالة وسيطة (middleware) للتحقق من مصادقة المسؤول
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next(); // المستخدم مصادق عليه، اسمح بالمرور
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

// --- 3. مسارات الواجهة البرمجية (API Routes) ---

// ## المسارات العامة (لا تتطلب تسجيل دخول) ##
app.post('/api/questions', (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim() === '') {
    return res.status(400).json({ error: 'نص السؤال مطلوب ولا يمكن أن يكون فارغًا' });
  }
  const questions = loadQuestions();
  const newQuestion = { id: Date.now(), question: question.trim(), answer: '', date: new Date().toISOString() };
  questions.unshift(newQuestion);
  saveQuestions(questions);
  res.status(201).json({ message: 'تم استلام السؤال بنجاح!', question: newQuestion });
});

app.get('/api/answered', (_req, res) => {
  const answeredQuestions = loadQuestions().filter(q => q.answer).sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(answeredQuestions);
});

// ## مسارات المسؤولين (تتطلب تسجيل دخول) ##
app.post('/admin/login', (req, res) => {
  const submittedPassword = (req.body.password || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true; // إنشاء الجلسة
    req.session.user = { role: 'admin' };
    res.json({ message: 'تم تسجيل الدخول بنجاح' });
  } else {
    res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
});

// مسار جديد ومحصّن للتحقق من حالة الجلسة
app.get('/admin/status', requireAuth, (req, res) => {
  res.json({ message: 'Authenticated' });
});

// مسار جديد ومحصّن لتسجيل الخروج
app.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'لا يمكن تسجيل الخروج، يرجى المحاولة مرة أخرى' });
    }
    res.clearCookie('connect.sid'); // اسم الكعكة الافتراضي لـ express-session
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
  });
});

app.get('/admin/questions', requireAuth, (req, res) => {
  res.json(loadQuestions());
});

app.post('/admin/answer', requireAuth, (req, res) => {
  const { id, answer } = req.body;
  if (!id || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ error: 'معرف السؤال وإجابة غير فارغة مطلوبان' });
  }
  const questions = loadQuestions();
  const index = questions.findIndex(q => q.id === Number(id));
  if (index === -1) {
    return res.status(404).json({ error: 'السؤال غير موجود' });
  }
  questions[index].answer = answer.trim();
  saveQuestions(questions);
  res.json({ message: 'تم حفظ الجواب بنجاح' });
});


// --- 4. تقديم الملفات الثابتة (HTML, CSS, JS) ---
// يجب أن يكون هذا القسم بعد تعريف المسارات البرمجية
app.use(express.static(__dirname));

// --- 5. التشغيل والإعلام ---
app.listen(PORT, () => {
  console.log(`----------------------------------------------------`);
  console.log(`  مشروع نور الحوزة يعمل الآن بنجاح...`);
  console.log(`  الخادم يستمع على الرابط: http://localhost:${PORT}`);
  console.log(`----------------------------------------------------`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`  ملاحظة: يتم استخدام كلمة المرور الافتراضية للمسؤول.`);
  }
});
