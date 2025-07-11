require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getStore } = require('@netlify/blobs');
const { Store } = require('express-session');
const bodyParser = require('body-parser');

// =================================================================
// ديوان حفظ الجلسات (NetlifyBlobStore)
// وحدة مخصصة لتخزين جلسات المستخدمين بشكل دائم في Netlify Blobs
// مما يضمن بقاء تسجيل الدخول فعالاً في البيئة السحابية عديمة الحالة.
// =================================================================
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        this.store = getStore({ name: this.storeName, consistency: 'strong' });
    }

    get(sid, callback) {
        this.store.get(sid, { type: 'json' })
            .then(data => callback(null, data))
            .catch(err => {
                if (err.status === 404 || err.statusCode === 404) {
                    return callback(null, null); // Session not found is not an error
                }
                callback(err);
            });
    }

    set(sid, session, callback) {
        const maxAge = session.cookie.maxAge; // in milliseconds
        const ttl = maxAge ? Math.round(maxAge / 1000) : 86400; // 1 day default in seconds

        this.store.setJSON(sid, session, { ttl })
            .then(() => callback(null))
            .catch(err => callback(err));
    }

    destroy(sid, callback) {
        this.store.delete(sid)
            .then(() => callback(null))
            .catch(err => {
                 if (err.status === 404 || err.statusCode === 404) {
                    return callback(null); // Already destroyed is not an error
                }
                callback(err);
            });
    }
}

// =================================================================
// إعدادات التطبيق الرئيسية
// =================================================================
const app = express();
const router = express.Router();

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-strong-and-long-secret-for-production-environment';

// --- إعدادات الوسيط (Middleware Configuration) ---
// استخدام ديوان حفظ الجلسات الجديد للجلسات
const sessionStore = new NetlifyBlobStore({ storeName: 'sessions' });

app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true
}));
app.use(helmet());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(bodyParser.text({ type: 'text/*' }));

app.set('trust proxy', 1); // مهم جداً في Netlify Functions ليعمل secure cookie

app.use(session({
  store: sessionStore, // <-- الربط مع المتجر السحابي
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // مهم جداً مع Netlify/Heroku
  cookie: {
    secure: true, // Netlify دائماً https
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
  standardHeaders: true,
  legacyHeaders: false,
});


// =================================================================
// دوال مساعدة لإدارة البيانات مع Netlify Blobs (البديل لنظام الملفات)
// =================================================================
const questionsStore = getStore('questions');
const QUESTIONS_KEY = 'all-questions';

/**
 * @description يقرأ جميع الأسئلة من Netlify Blobs.
 * @returns {Promise<Array>} - مصفوفة الأسئلة.
 */
async function loadQuestions() {
    try {
        const questions = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return questions || []; // إذا لم يتم العثور على شيء، أرجع مصفوفة فارغة
    } catch (error) {
        if (error.status === 404 || error.statusCode === 404) {
            // الملف غير موجود بعد، وهذا طبيعي في البداية
            return [];
        }
        // في حالة وجود خطأ آخر، يجب تسجيله وإعلام المطور
        console.error("خطأ حرج عند قراءة البيانات من Netlify Blobs:", error);
        throw new Error('فشل استرجاع البيانات من المخزن السحابي.');
    }
}

/**
 * @description يحفظ مصفوفة الأسئلة الكاملة في Netlify Blobs.
 * @param {Array} questions - مصفوفة الأسئلة المراد حفظها.
 * @returns {Promise<void>}
 */
async function saveQuestions(questions) {
    try {
        await questionsStore.setJSON(QUESTIONS_KEY, questions);
    } catch (error) {
        console.error("خطأ حرج عند الكتابة في Netlify Blobs:", error);
        throw new Error('فشل حفظ البيانات في المخزن السحابي.');
    }
}

// وسيط للتحقق من أن المستخدم مسجل كمسؤول
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};


// =================================================================
// المسارات (API Routes)
// =================================================================

// --- المسارات العامة (متاحة للجميع) ---

// استقبال سؤال جديد من المستخدمين
router.post('/questions', async (req, res) => {
  let questionText = req.body.question;
  if (!questionText && typeof req.body === 'string') {
    questionText = req.body;
  }
  if (!questionText || typeof questionText !== 'string' || questionText.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب ويجب أن يكون ذا معنى.' });
  }

  try {
    const questions = await loadQuestions();
    const newEntry = {
      id: Date.now(),
      question: questionText.trim(),
      answer: '',
      tags: [],
      source: '',
      date: new Date().toISOString(),
      answeredDate: null,
      lastModified: null
    };
    questions.unshift(newEntry); // إضافة السؤال الجديد في بداية القائمة

    await saveQuestions(questions);
    res.status(201).json({ success: true, message: 'تم استلام السؤال بنجاح. شكراً لكم.' });
  } catch (err) {
    console.error("Server error in POST /questions:", err);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ السؤال.' });
  }
});

// جلب الأسئلة المجابة فقط لعرضها في الصفحة العامة
router.get('/answered', async (_req, res) => {
  try {
    const questions = await loadQuestions();
    const answeredQuestions = questions
      .filter(q => q.answer && q.answer.trim() !== '')
      .sort((a, b) => new Date(b.answeredDate || b.date) - new Date(a.answeredDate || a.date));
    res.status(200).json(answeredQuestions);
  } catch (err) {
    console.error("Server error in GET /answered:", err);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب الأسئلة.' });
  }
});


// --- مسارات المسؤولين الخاصة (تتطلب تسجيل الدخول) ---

// تسجيل دخول المسؤول
router.post('/admin/login', loginLimiter, (req, res) => {
  let submittedPassword = req.body.password || (typeof req.body === 'string' ? req.body : '');
  submittedPassword = submittedPassword.trim();

  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.regenerate(err => {
      if (err) {
        console.error("Session regeneration error:", err);
        return res.status(500).json({ success: false, error: 'خطأ في إنشاء الجلسة.' });
      }
      req.session.authenticated = true;
      req.session.save(err2 => {
        if (err2) {
          console.error("Session save error:", err2);
          return res.status(500).json({ success: false, error: 'خطأ في حفظ الجلسة.' });
        }
        res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
      });
    });
  } else {
    res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
  }
});

// تسجيل خروج المسؤول
router.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ success: false, error: 'فشل في إنهاء الجلسة.' });
    }
    res.clearCookie('connect.sid'); // The default cookie name is 'connect.sid'
    res.status(200).json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
  });
});

// التحقق من حالة تسجيل الدخول
router.get('/admin/status', requireAuth, (req, res) => {
  res.status(200).json({ success: true, authenticated: true });
});

// جلب كل الأسئلة (المجابة وغير المجابة) للوحة التحكم
router.get('/admin/questions', requireAuth, async (req, res) => {
    try {
        const questions = await loadQuestions();
        res.status(200).json(questions.sort((a, b) => new Date(b.date) - new Date(a.date)));
    } catch (error) {
        console.error("Server error in GET /admin/questions:", error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم عند جلب المسائل.' });
    }
});

// **مسار جديد**: إضافة مسألة كاملة (سؤال وجواب وتصنيفات) بواسطة المسؤول
router.post('/admin/question', requireAuth, async (req, res) => {
    const { question, answer, tags, source } = req.body;
    if (!question || typeof question !== 'string' || question.trim() === '') {
        return res.status(400).json({ success: false, error: 'نص المسألة مطلوب.' });
    }

    try {
        const questions = await loadQuestions();
        const now = new Date().toISOString();
        const newQuestion = {
            id: Date.now(),
            question: question.trim(),
            answer: (answer || '').trim(),
            tags: Array.isArray(tags) ? tags : [],
            source: (source || '').trim(),
            date: now,
            answeredDate: answer ? now : null,
            lastModified: null
        };
        questions.unshift(newQuestion);
        await saveQuestions(questions);
        res.status(201).json({ success: true, message: 'تمت إضافة المسألة بنجاح.', question: newQuestion });
    } catch (error) {
        console.error("Server error in POST /admin/question:", error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إضافة المسألة.' });
    }
});

// تحديث مسألة موجودة (سؤال، جواب، تصنيفات، مصدر)
router.put('/admin/question/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { question, answer, tags, source } = req.body;

    if (!question || typeof question !== 'string' || question.trim() === '') {
        return res.status(400).json({ success: false, error: 'نص السؤال المحدث مطلوب.' });
    }

    try {
        const questions = await loadQuestions();
        const questionIndex = questions.findIndex(q => q.id === Number(id));

        if (questionIndex === -1) {
            return res.status(404).json({ success: false, error: 'لم يتم العثور على المسألة المطلوبة.' });
        }
        
        const originalQuestion = questions[questionIndex];
        const now = new Date().toISOString();

        // تحديث البيانات
        originalQuestion.question = question.trim();
        originalQuestion.answer = (answer || '').trim();
        originalQuestion.tags = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];
        originalQuestion.source = (source || '').trim();
        originalQuestion.lastModified = now;

        // إذا لم يكن هناك تاريخ إجابة وتمت إضافة جواب الآن، فقم بتعيينه
        if (!originalQuestion.answeredDate && originalQuestion.answer) {
            originalQuestion.answeredDate = now;
        }
        
        questions[questionIndex] = originalQuestion;

        await saveQuestions(questions);
        res.status(200).json({ success: true, message: 'تم تحديث المسألة بنجاح.', question: originalQuestion });
    } catch (error) {
        console.error(`Server error in PUT /admin/question/${id}:`, error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث المسألة.' });
    }
});


// حذف مسألة
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
    console.error(`Server error in DELETE /admin/question/${id}:`, error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حذف السؤال.' });
  }
});


// =================================================================
// التصدير النهائي للوظيفة السحابية
// =================================================================
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
