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
// ديوان حفظ الجلسات (NetlifyBlobStore) - نسخة محسّنة مع تسجيل أخطاء أفضل
// =================================================================
class NetlifyBlobStore extends Store {
    constructor(options = {}) {
        super(options);
        this.storeName = options.storeName || 'sessions';
        this.store = getStore({ name: this.storeName, consistency: 'strong' });
        console.log(`[INFO] ديوان حفظ الجلسات '${this.storeName}' تم تهيئته بنجاح.`);
    }

    get(sid, callback) {
        console.log(`[SESSION] محاولة استرجاع الجلسة: ${sid}`);
        this.store.get(sid, { type: 'json' })
            .then(data => {
                console.log(`[SESSION] تم العثور على بيانات الجلسة: ${sid}`, data ? '(بيانات موجودة)' : '(لا توجد بيانات)');
                callback(null, data);
            })
            .catch(err => {
                if (err.status === 404 || err.statusCode === 404) {
                    console.log(`[SESSION] الجلسة ${sid} غير موجودة في المخزن.`);
                    return callback(null, null);
                }
                console.error(`[SESSION ERROR] خطأ حرج عند قراءة الجلسة ${sid}:`, err);
                callback(err);
            });
    }

    set(sid, session, callback) {
        const maxAge = session.cookie.maxAge;
        const ttl = maxAge ? Math.round(maxAge / 1000) : 86400; // 1 day default

        console.log(`[SESSION] محاولة حفظ الجلسة: ${sid} مع مدة صلاحية (TTL): ${ttl} ثانية.`);
        this.store.setJSON(sid, session, { ttl })
            .then(() => {
                console.log(`[SESSION] تم حفظ الجلسة بنجاح: ${sid}`);
                callback(null);
            })
            .catch(err => {
                console.error(`[SESSION ERROR] خطأ حرج عند حفظ الجلسة ${sid}:`, err);
                callback(err);
            });
    }

    destroy(sid, callback) {
        console.log(`[SESSION] محاولة حذف الجلسة: ${sid}`);
        this.store.delete(sid)
            .then(() => {
                console.log(`[SESSION] تم حذف الجلسة بنجاح: ${sid}`);
                callback(null);
            })
            .catch(err => {
                if (err.status === 404 || err.statusCode === 404) {
                    console.warn(`[SESSION] محاولة حذف جلسة غير موجودة أصلاً: ${sid}. لا يعتبر هذا خطأ.`);
                    return callback(null);
                }
                console.error(`[SESSION ERROR] خطأ حرج عند حذف الجلسة ${sid}:`, err);
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

// [DIAGNOSTIC] طباعة جزء من كلمة المرور للتأكد من أنها ليست فارغة
console.log(`[DIAGNOSTIC] تم تحميل كلمة مرور المسؤول. هل هي القيمة الافتراضية؟ ${ADMIN_PASSWORD === 'change-this-default-password'}. طولها: ${ADMIN_PASSWORD.length}`);
if (ADMIN_PASSWORD === 'change-this-default-password') {
    console.warn("[SECURITY WARNING] يتم استخدام كلمة المرور الافتراضية. يرجى تعيين متغير بيئة 'ADMIN_PASSWORD' في إعدادات Netlify فوراً!");
}

const sessionStore = new NetlifyBlobStore({ storeName: 'user-sessions' });

app.use(cors({
  origin: true, // السماح لجميع المصادر، Netlify سيتعامل مع هذا
  credentials: true
}));
app.use(helmet());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(bodyParser.text({ type: 'text/*' }));

app.set('trust proxy', 1);

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
  standardHeaders: true, legacyHeaders: false,
});

// =================================================================
// دوال مساعدة لإدارة البيانات مع Netlify Blobs
// =================================================================
const questionsStore = getStore('questions');
const QUESTIONS_KEY = 'all-questions';

async function loadQuestions() {
    try {
        const questions = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
        return questions || [];
    } catch (error) {
        if (error.status === 404) return [];
        console.error("[BLOBS ERROR] فشل قراءة الأسئلة:", error);
        throw new Error('فشل استرجاع البيانات من المخزن السحابي.');
    }
}

async function saveQuestions(questions) {
    try {
        await questionsStore.setJSON(QUESTIONS_KEY, questions);
    } catch (error) {
        console.error("[BLOBS ERROR] فشل حفظ الأسئلة:", error);
        throw new Error('فشل حفظ البيانات في المخزن السحابي.');
    }
}

// وسيط التحقق من المصادقة مع تسجيل أحداث مفصل
const requireAuth = (req, res, next) => {
  console.log(`[AUTH] التحقق من المصادقة للمسار: ${req.originalUrl}`);
  console.log(`[AUTH] هل الجلسة موجودة؟ ${!!req.session}`);
  if (req.session) {
    console.log(`[AUTH] هل المستخدم مصادق عليه؟ ${req.session.authenticated}`);
  }

  if (req.session && req.session.authenticated === true) {
    console.log(`[AUTH] المصادقة ناجحة. السماح بالمرور.`);
    return next();
  }
  
  console.warn(`[AUTH] المصادقة فشلت. رفض الوصول.`);
  res.status(401).json({ success: false, error: 'غير مصادق عليه. يرجى تسجيل الدخول أولاً.' });
};


// =================================================================
// المسارات (API Routes)
// =================================================================

// --- مسار تسجيل دخول المسؤول (مع تشخيص كامل) ---
router.post('/admin/login', loginLimiter, (req, res) => {
  console.log('----------------------------------------------------');
  console.log('[LOGIN ATTEMPT] بدأت محاولة تسجيل دخول جديدة.');
  
  let submittedPassword = (req.body.password || (typeof req.body === 'string' ? req.body : '')).trim();
  
  console.log(`[LOGIN ATTEMPT] كلمة المرور المستلمة (طولها): ${submittedPassword.length}`);
  
  // لا تقم أبداً بطباعة كلمة المرور الكاملة في السجلات الإنتاجية
  const submittedPasswordExcerpt = submittedPassword.substring(0, 2) + '...';
  const adminPasswordExcerpt = ADMIN_PASSWORD.substring(0, 2) + '...';
  
  console.log(`[LOGIN ATTEMPT] مقتطف من كلمة المرور المستلمة: '${submittedPasswordExcerpt}'`);
  console.log(`[LOGIN ATTEMPT] مقتطف من كلمة المرور المخزنة: '${adminPasswordExcerpt}'`);

  const passwordsMatch = (submittedPassword === ADMIN_PASSWORD);
  console.log(`[LOGIN ATTEMPT] نتيجة المقارنة: ${passwordsMatch ? '<<< ناجحة >>>' : '<<< فاشلة >>>'}`);

  if (passwordsMatch) {
    console.log('[LOGIN SUCCESS] كلمة المرور صحيحة. جاري إنشاء جلسة جديدة...');
    req.session.regenerate(err => {
      if (err) {
        console.error("[SESSION ERROR] خطأ حرج عند إعادة إنشاء الجلسة:", err);
        return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام الجلسات.' });
      }
      
      console.log('[SESSION] تم إعادة إنشاء الجلسة بنجاح. جاري تعيين المصادقة...');
      req.session.authenticated = true;
      
      req.session.save(err2 => {
        if (err2) {
          console.error("[SESSION ERROR] خطأ حرج عند حفظ الجلسة بعد تعيين المصادقة:", err2);
          return res.status(500).json({ success: false, error: 'خطأ داخلي في حفظ الجلسة.' });
        }
        console.log('[LOGIN FINAL] تم حفظ الجلسة والمصادقة بنجاح. إرسال رد إيجابي للمستخدم.');
        console.log('----------------------------------------------------');
        res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
      });
    });
  } else {
    console.warn('[LOGIN FAILURE] كلمة المرور غير صحيحة. إرسال رد سلبي للمستخدم.');
    console.log('----------------------------------------------------');
    res.status(401).json({ success: false, error: 'كلمة المرور المدخلة غير صحيحة.' });
  }
});

// بقية المسارات تبقى كما هي...
// ... (الكود الكامل من الإجابة السابقة للمسارات الأخرى مثل /logout, /questions, /answered, etc.)

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
    questions.unshift(newEntry);

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

// تسجيل خروج المسؤول
router.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ success: false, error: 'فشل في إنهاء الجلسة.' });
    }
    res.clearCookie('connect.sid');
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

// إضافة مسألة كاملة (سؤال وجواب وتصنيفات) بواسطة المسؤول
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

        originalQuestion.question = question.trim();
        originalQuestion.answer = (answer || '').trim();
        originalQuestion.tags = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];
        originalQuestion.source = (source || '').trim();
        originalQuestion.lastModified = now;

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
// التصدير النهائي
// =================================================================
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
