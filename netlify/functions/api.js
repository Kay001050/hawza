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

// --- القسم الثالث: إعدادات الوسيط (Middleware Configuration) ---
app.use(cors({
  origin: (origin, callback) => callback(null, true), // السماح بكل origins (للاختبار)
  credentials: true
}));
app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: 'text/*' }));

app.set('trust proxy', 1); // مهم جداً في Netlify Functions ليعمل secure cookie

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // مهم جداً مع Netlify/Heroku
  cookie: {
    secure: true, // Netlify دائماً https
    httpOnly: true,
    sameSite: 'none', // Netlify تتطلب sameSite=none مع secure=true
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

// --- القسم الرابع: دوال مساعدة لإدارة البيانات مع آلية القفل (Data Helper Functions with Locking) ---

/**
 * @description يضمن وجود مجلد البيانات وملف الأسئلة.
 */
function ensureDataFileExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }
}

/**
 * @description محاولة الحصول على قفل للكتابة في الملف.
 * @returns {boolean} - true إذا تم الحصول على القفل، false إذا كان الملف مقفلاً.
 */
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    // إذا كان القفل موجودًا لأكثر من 5 ثوانٍ، فمن المحتمل أنه عالق. نزيله.
    const lockStat = fs.statSync(LOCK_FILE);
    const lockAge = (new Date().getTime() - lockStat.mtime.getTime()) / 1000;
    if (lockAge > 5) {
      releaseLock();
    } else {
      return false; // فشل الحصول على القفل
    }
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
  return true; // تم الحصول على القفل بنجاح
}

/**
 * @description تحرير القفل بعد الانتهاء من الكتابة.
 */
function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
  }
}

/**
 * @description يقرأ الأسئلة من ملف JSON.
 * @returns {Array} - مصفوفة الأسئلة.
 */
function loadQuestions() {
  ensureDataFileExists();
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("خطأ حرج عند قراءة ملف البيانات:", error);
    return []; // إرجاع مصفوفة فارغة في حالة الفشل لمنع انهيار النظام
  }
}

/**
 * @description يحفظ مصفوفة الأسئلة في ملف JSON باستخدام آلية القفل.
 * @param {Array} questions - مصفوفة الأسئلة المراد حفظها.
 * @returns {boolean} - true عند النجاح، false عند الفشل.
 */
function saveQuestions(questions) {
  if (!acquireLock()) {
    console.error("فشل في الحصول على قفل للكتابة. العملية متوقفة لتجنب تلف البيانات.");
    return false;
  }
  try {
    ensureDataFileExists();
    fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error("خطأ حرج عند كتابة ملف البيانات:", error);
    return false;
  } finally {
    releaseLock(); // تحرير القفل دائماً، سواء نجحت العملية أم فشلت
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

// استقبال الأسئلة من المستخدمين
router.post('/questions', (req, res) => {
  let question = req.body.question;
  // دعم body إذا أرسل كنص خام
  if (!question && typeof req.body === 'string') {
    question = req.body;
  }
  if (!question || typeof question !== 'string' || question.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'نص السؤال مطلوب ويجب أن يكون ذا معنى.' });
  }

  try {
    const questions = loadQuestions();
    const newEntry = {
      id: Date.now(),
      question: question.trim(),
      answer: '',
      date: new Date().toISOString(),
      answeredDate: null,
      lastModified: null
    };
    questions.unshift(newEntry);

    if (saveQuestions(questions)) {
      res.status(201).json({ success: true, message: 'تم استلام السؤال بنجاح. شكراً لكم.' });
    } else {
      res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ السؤال.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ السؤال.' });
  }
});

router.get('/answered', (_req, res) => {
  const questions = loadQuestions()
    .filter(q => q.answer)
    .sort((a, b) => new Date(b.answeredDate || b.date) - new Date(a.answeredDate || a.date));
  res.status(200).json(questions);
});


// --- مسارات المسؤولين الخاصة ---

router.post('/admin/login', loginLimiter, (req, res) => {
  let submittedPassword = req.body.password;
  if (!submittedPassword && typeof req.body === 'string') {
    submittedPassword = req.body;
  }
  submittedPassword = (submittedPassword || '').trim();
  if (submittedPassword && submittedPassword === ADMIN_PASSWORD) {
    req.session.regenerate(err => {
      if (err) {
        return res.status(500).json({ success: false, error: 'خطأ في إنشاء الجلسة.' });
      }
      req.session.authenticated = true;
      req.session.save(err2 => {
        if (err2) {
          return res.status(500).json({ success: false, error: 'خطأ في حفظ الجلسة.' });
        }
        res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
      });
    });
  } else {
    res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
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

router.post('/admin/answer', requireAuth, (req, res) => {
  const { id, answer } = req.body;
  if (!id || !answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'معرف السؤال ونص الإجابة مطلوبان.' });
  }
  try {
    const questions = loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));
    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
    }
    questions[questionIndex].answer = answer.trim();
    questions[questionIndex].answeredDate = new Date().toISOString();
    
    if (saveQuestions(questions)) {
      res.status(200).json({ success: true, message: 'تم حفظ الجواب بنجاح.' });
    } else {
      res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ الجواب.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حفظ الجواب.' });
  }
});

router.put('/admin/question/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { answer } = req.body;
  if (!answer || typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ success: false, error: 'نص الإجابة المحدث مطلوب.' });
  }
  try {
    const questions = loadQuestions();
    const questionIndex = questions.findIndex(q => q.id === Number(id));
    if (questionIndex === -1) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب.' });
    }
    questions[questionIndex].answer = answer.trim();
    questions[questionIndex].lastModified = new Date().toISOString();
    
    if (saveQuestions(questions)) {
      res.status(200).json({ success: true, message: 'تم تحديث الجواب بنجاح.' });
    } else {
      res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث الجواب.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء تحديث الجواب.' });
  }
});

router.delete('/admin/question/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  try {
    let questions = loadQuestions();
    const initialLength = questions.length;
    questions = questions.filter(q => q.id !== Number(id));
    if (initialLength === questions.length) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على السؤال المطلوب لحذفه.' });
    }
    
    if (saveQuestions(questions)) {
      res.status(200).json({ success: true, message: 'تم حذف السؤال بنجاح.' });
    } else {
      res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حذف السؤال.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء حذف السؤال.' });
  }
});


// =================================================================
// التصدير النهائي للوظيفة السحابية
// =================================================================
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);