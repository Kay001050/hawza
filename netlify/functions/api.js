require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const app = express();
const router = express.Router();

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment';
const STORE_NAME = 'questions';

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

async function loadQuestions() {
  try {
    const store = getStore(STORE_NAME);
    const data = await store.get('all_questions', { type: 'json' });
    return data || [];
  } catch (error) {
    if (error.status === 404) {
      return [];
    }
    console.error("خطأ حرج عند قراءة البيانات من المخزن السحابي:", error);
    return [];
  }
}

async function saveQuestions(questions) {
  try {
    const store = getStore(STORE_NAME);
    await store.setJSON('all_questions', questions);
  } catch (error) {
    console.error("خطأ حرج عند كتابة البيانات في المخزن السحابي:", error);
    throw new Error('فشل الخادم في حفظ البيانات في المخزن السحابي.');
  }
}

const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};

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
      source: 'مستخدم عام',
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

router.get('/answered', async (req, res) => {
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

router.post('/admin/login', loginLimiter, (req, res) => {
    const submittedPassword = (req.body.password || '').trim();
    if (!submittedPassword) {
        return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
    }

    try {
        const adminPassBuffer = Buffer.from(ADMIN_PASSWORD, 'utf8');
        const submittedPassBuffer = Buffer.from(submittedPassword, 'utf8');

        if (adminPassBuffer.length !== submittedPassBuffer.length) {
            return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
        }

        const areEqual = crypto.timingSafeEqual(adminPassBuffer, submittedPassBuffer);

        if (areEqual) {
            req.session.authenticated = true;
            res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
        } else {
            res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
        }
    } catch (error) {
        console.error("خطأ أثناء التحقق من كلمة المرور:", error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء عملية المصادقة.' });
    }
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
    try {
        const questions = await loadQuestions();
        res.status(200).json(questions.sort((a, b) => new Date(b.date) - new Date(a.date)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب جميع الأسئلة.' });
    }
});

router.post('/admin/question', requireAuth, async (req, res) => {
  const { question, source } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب.' });
  }

  try {
    const questions = await loadQuestions();
    const newEntry = {
      id: Date.now(),
      question: question.trim(),
      answer: '',
      source: source ? source.trim() : 'إدخال إداري',
      date: new Date().toISOString(),
      answeredDate: null,
      lastModified: null
    };
    questions.unshift(newEntry);
    
    await saveQuestions(questions);
    res.status(201).json({ success: true, message: 'تمت إضافة المسألة بنجاح.', question: newEntry });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إضافة المسألة.' });
  }
});


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

router.put('/admin/question/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { question, answer, source } = req.body;

  if (!question || typeof question !== 'string' || question.trim() === '') {
      return res.status(400).json({ success: false, error: 'نص السؤال المحدث مطلوب.' });
  }

  try {
    const questions = await loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));
    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
    }
    
    const targetQuestion = questions[questionIndex];
    targetQuestion.question = question.trim();
    targetQuestion.source = source ? source.trim() : targetQuestion.source;
    targetQuestion.lastModified = new Date().toISOString();

    if (answer !== undefined) {
        targetQuestion.answer = answer;
        if (answer && !targetQuestion.answeredDate) {
            targetQuestion.answeredDate = new Date().toISOString();
        }
    }
    
    await saveQuestions(questions);
    res.status(200).json({ success: true, message: 'تم تحديث المسألة بنجاح.', question: targetQuestion });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث المسألة.' });
  }
});

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

app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
