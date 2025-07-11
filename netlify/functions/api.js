require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { Store } = require('express-session');

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
                if (err.status === 404) {
                    return callback(null, null); // Session not found is not an error
                }
                callback(err);
            });
    }

    set(sid, session, callback) {
        // Add a TTL (Time To Live) to the session data
        const maxAge = session.cookie.maxAge; // in milliseconds
        const ttl = maxAge ? Math.round(maxAge / 1000) : 86400; // 1 day default

        this.store.setJSON(sid, session, { ttl })
            .then(() => callback(null))
            .catch(err => callback(err));
    }

    destroy(sid, callback) {
        this.store.delete(sid)
            .then(() => callback(null))
            .catch(err => {
                 if (err.status === 404) {
                    return callback(null); // Already destroyed
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

// استخدام ديوان حفظ الجلسات الجديد
const sessionStore = new NetlifyBlobStore({ storeName: 'sessions' });

app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: sessionStore, // <-- هنا يكمن الحل!
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 أيام
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
  const store = getStore('questions');
  try {
    const data = await store.get('all_questions', { type: 'json' });
    return data || [];
  } catch (error) {
    if (error.status === 404) return [];
    console.error("خطأ حرج عند قراءة الأسئلة:", error);
    return [];
  }
}

async function saveQuestions(questions) {
  const store = getStore('questions');
  try {
    await store.setJSON('all_questions', questions);
  } catch (error) {
    console.error("خطأ حرج عند حفظ الأسئلة:", error);
    throw new Error('فشل الخادم في حفظ البيانات.');
  }
}

const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};


// =================================================================
// المسارات (API Routes)
// =================================================================

// --- المسارات العامة ---

router.post('/questions', async (req, res) => {
    // ... (This route remains unchanged)
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
            tags: [],
            date: new Date().toISOString(),
            answeredDate: null,
            lastModified: null
        };
        questions.unshift(newEntry);
        await saveQuestions(questions);
        res.status(201).json({ success: true, message: 'تم استلام السؤال بنجاح.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/answered', async (req, res) => {
    // ... (This route remains unchanged)
    try {
        const questions = await loadQuestions();
        const answered = questions
        .filter(q => q.answer)
        .sort((a, b) => new Date(b.answeredDate || b.date) - new Date(a.answeredDate || a.date));
        res.status(200).json(answered);
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب الأرشيف.' });
    }
});


// --- مسارات المسؤولين الخاصة ---

router.post('/admin/login', loginLimiter, (req, res) => {
    const submittedPassword = (req.body.password || '').trim();
    if (!submittedPassword) {
        return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
    }

    try {
        const adminPassBuffer = Buffer.from(ADMIN_PASSWORD, 'utf8');
        const submittedPassBuffer = Buffer.from(submittedPassword, 'utf8');

        if (adminPassBuffer.length !== submittedPassBuffer.length || !crypto.timingSafeEqual(adminPassBuffer, submittedPassBuffer)) {
            return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
        }

        req.session.authenticated = true;
        // The session middleware will automatically save the session to the Blob Store
        res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });

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
    res.clearCookie('connect.sid'); // The cookie name is defined by express-session
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم.' });
    }
});

router.post('/admin/question', requireAuth, async (req, res) => {
    const { question, source, tags } = req.body;
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
            tags: Array.isArray(tags) ? tags : [],
            date: new Date().toISOString(),
            answeredDate: null,
            lastModified: null
        };
        questions.unshift(newEntry);
        await saveQuestions(questions);
        res.status(201).json({ success: true, message: 'تمت إضافة المسألة بنجاح.', question: newEntry });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/admin/question/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { question, answer, source, tags } = req.body;

        if (!question) return res.status(400).json({ success: false, error: 'نص السؤال مطلوب.' });
        
        const questions = await loadQuestions();
        const questionIndex = questions.findIndex(q => q.id === Number(id));
        if (questionIndex === -1) return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال.' });

        const targetQuestion = questions[questionIndex];
        targetQuestion.question = question.trim();
        targetQuestion.source = source ? source.trim() : targetQuestion.source;
        targetQuestion.tags = Array.isArray(tags) ? tags : targetQuestion.tags;
        targetQuestion.lastModified = new Date().toISOString();
        if (answer !== undefined) {
            targetQuestion.answer = answer;
            if (answer && !targetQuestion.answeredDate) {
                targetQuestion.answeredDate = new Date().toISOString();
            }
        }
        
        await saveQuestions(questions);
        res.status(200).json({ success: true, message: 'تم تحديث المسألة بنجاح.', question: targetQuestion });
    } catch(error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/admin/question/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        let questions = await loadQuestions();
        const initialLength = questions.length;
        questions = questions.filter(q => q.id !== Number(id));
        if (initialLength === questions.length) {
            return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال لحذفه.' });
        }
        await saveQuestions(questions);
        res.status(200).json({ success: true, message: 'تم حذف السؤال بنجاح.' });
    } catch(error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// =================================================================
// التصدير النهائي للوظيفة السحابية
// =================================================================
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);