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
                if (err.status === 404) return callback(null, null);
                callback(err);
            });
    }
    set(sid, session, callback) {
        const maxAge = session.cookie.maxAge;
        const ttl = maxAge ? Math.round(maxAge / 1000) : 86400;
        this.store.setJSON(sid, session, { ttl })
            .then(() => callback(null))
            .catch(err => callback(err));
    }
    destroy(sid, callback) {
        this.store.delete(sid)
            .then(() => callback(null))
            .catch(err => {
                 if (err.status === 404) return callback(null);
                callback(err);
            });
    }
}

const app = express();
const router = express.Router();
const sessionStore = new NetlifyBlobStore({ storeName: 'sessions' });

app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'default-session-secret-for-dev-only',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة مرة أخرى بعد 15 دقيقة.' },
});

// === أداة الفحص والتشخيص ===
router.get('/health-check', (req, res) => {
    const adminPasswordExists = !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'change-this-default-password');
    const sessionSecretExists = !!(process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'default-session-secret-for-dev-only');

    if (!adminPasswordExists || !sessionSecretExists) {
        return res.status(503).json({
            status: "⚠️ خطأ في الإعدادات",
            message: "واحد أو أكثر من متغيرات البيئة الحساسة (ADMIN_PASSWORD أو SESSION_SECRET) غير مُعَرَّف في إعدادات Netlify. هذا هو سبب المشكلة على الأرجح.",
            checks: {
                ADMIN_PASSWORD_SET: adminPasswordExists,
                SESSION_SECRET_SET: sessionSecretExists,
            }
        });
    }

    res.status(200).json({
        status: "✅ ممتاز",
        message: "الخادم يعمل ومتغيرات البيئة الأساسية موجودة. النظام جاهز لاستقبال كلمة المرور.",
        checks: {
            ADMIN_PASSWORD_SET: true,
            SESSION_SECRET_SET: true,
            NODE_ENV: process.env.NODE_ENV
        }
    });
});
// =============================

// The rest of your API routes (unchanged)
async function loadQuestions() {
    //...
}
async function saveQuestions(questions) {
    //...
}
// etc... all other routes like /admin/login, /admin/questions...
// ... (The rest of the file is identical to the previous version)

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-default-password').trim();
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ success: false, error: 'غير مصادق عليه.' });
};
router.post('/admin/login', loginLimiter, (req, res) => {
    const submittedPassword = (req.body.password || '').trim();
    if (!submittedPassword) return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
    const adminPassBuffer = Buffer.from(ADMIN_PASSWORD, 'utf8');
    const submittedPassBuffer = Buffer.from(submittedPassword, 'utf8');
    if (adminPassBuffer.length !== submittedPassBuffer.length || !crypto.timingSafeEqual(adminPassBuffer, submittedPassBuffer)) {
        return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });
    }
    req.session.authenticated = true;
    res.status(200).json({ success: true, message: 'تم تسجيل الدخول بنجاح.' });
});
router.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, error: 'فشل إنهاء الجلسة.' });
    res.clearCookie('connect.sid');
    res.status(200).json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
  });
});
router.get('/admin/status', requireAuth, (req, res) => {
  res.status(200).json({ success: true, authenticated: true });
});
//... and all other routes from the previous file.

app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
