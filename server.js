require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key', // تم وضع قيمة افتراضية أقوى
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data', 'questions.json');

// --- بداية التعديلات والتحسينات ---

// 1. تحصين كلمة المرور: استخدام trim() لإزالة أي مسافات بيضاء عرضية من ملف .env
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Kjm#82@NwrA!2025').trim();

// 2. إضافة سجلات تشخيصية: عند بدء تشغيل السيرفر، يتم إعلامك بمصدر كلمة المرور المستخدمة
if (process.env.ADMIN_PASSWORD) {
  console.log('INFO: تم تحميل كلمة مرور المسؤول من ملف متغيرات البيئة (.env).');
} else {
  console.log('INFO: يتم استخدام كلمة مرور المسؤول الافتراضية المضمنة في الكود.');
}
// --- نهاية التعديلات والتحسينات ---

// Ensure data directory and file exist to prevent runtime errors
if (!fs.existsSync(DATA_FILE)) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
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

app.post('/api/questions', (req, res) => {
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
  questions.unshift(entry); // استخدام unshift لإضافة السؤال الجديد في بداية القائمة
  saveQuestions(questions);
  res.status(201).json({ message: 'Question stored', entry });
});

app.get('/api/questions', (_req, res) => {
  const questions = loadQuestions();
  res.json(questions);
});

app.post('/admin/login', (req, res) => {
  // 3. تحصين المدخلات: استلام كلمة المرور، التحقق من وجودها، وإزالة أي مسافات بيضاء منها
  const submittedPassword = (req.body.password || '').trim();

  // التحقق من أن كلمة المرور ليست فارغة بعد التنظيف ومقارنتها
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    console.log(`INFO: Admin login successful at ${new Date().toLocaleString()}`);
    return res.json({ message: 'Logged in' });
  }
  
  console.warn(`WARN: Failed admin login attempt at ${new Date().toLocaleString()}`);
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/admin/questions', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(loadQuestions());
});

app.post('/admin/answer', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { id, answer } = req.body;
  
  if (!id || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ error: 'Invalid payload: ID and a non-empty answer are required.' });
  }

  const questions = loadQuestions();
  
  // 4. إصلاح الخلل الحرج: تحويل `id` القادم من الطلب إلى رقم قبل مقارنته
  // لأن `q.id` هو رقم (Number) بينما `id` من الطلب هو نص (String).
  const index = questions.findIndex(q => q.id === Number(id));

  if (index === -1) {
    return res.status(404).json({ error: 'Question not found' });
  }
  
  questions[index].answer = answer.trim();
  saveQuestions(questions);
  res.json({ message: 'Answer saved' });
});

app.get('/api/answered', (_req, res) => {
  const questions = loadQuestions().filter(q => q.answer).sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(questions);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;

