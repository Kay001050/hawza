require('dotenv').config();
const serverless = require('serverless-http');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = process.env.SESSION_SECRET;
const BLOB_SITE_ID = process.env.BLOBS_SITE_ID;
const BLOB_TOKEN = process.env.BLOBS_TOKEN;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  throw new Error('FATAL: ADMIN_PASSWORD and SESSION_SECRET environment variables must be set.');
}

class NetlifyBlobStore extends session.Store {
  constructor(options = {}) {
    super();
    const storeOptions = { name: options.storeName || 'sessions', consistency: 'strong' };
    if (BLOB_SITE_ID && BLOB_TOKEN) {
      storeOptions.siteID = BLOB_SITE_ID;
      storeOptions.token = BLOB_TOKEN;
    }
    this.store = getStore(storeOptions);
  }
  get(sid, cb) {
    this.store.get(sid, { type: 'json' }).then(data => cb(null, data)).catch(err => {
      if (err.status === 404) return cb(null, null);
      cb(err);
    });
  }
  set(sid, sess, cb) {
    const ttl = sess.cookie.maxAge ? Math.round(sess.cookie.maxAge / 1000) : 86400;
    this.store.setJSON(sid, sess, { ttl }).then(() => cb(null)).catch(cb);
  }
  destroy(sid, cb) {
    this.store.delete(sid).then(() => cb(null)).catch(err => {
      if (err.status === 404) return cb(null);
      cb(err);
    });
  }
}

const app = express();

const sessionStore = new NetlifyBlobStore({ storeName: 'user-sessions' });
const questionsStoreOptions = { name: 'questions', consistency: 'strong' };
if (BLOB_SITE_ID && BLOB_TOKEN) {
  questionsStoreOptions.siteID = BLOB_SITE_ID;
  questionsStoreOptions.token = BLOB_TOKEN;
}
const questionsStore = getStore(questionsStoreOptions);

const QUESTIONS_KEY = 'all-questions-v1';

async function loadQuestions() {
  try {
    const data = await questionsStore.get(QUESTIONS_KEY, { type: 'json' });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function saveQuestions(items) {
  await questionsStore.setJSON(QUESTIONS_KEY, items);
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  name: 'hawza.sid',
  cookie: { secure: true, httpOnly: true, sameSite: 'none', maxAge: 1000 * 60 * 60 * 8 }
}));

const requireAuth = (req, res, next) => {
  if (req.session?.authenticated) return next();
  res.status(401).json({ success: false, error: 'Authentication required.' });
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const adminRouter = express.Router();

adminRouter.post('/login', loginLimiter, (req, res, next) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.authenticated = true;
      req.session.save(err => {
        if (err) return next(err);
        res.json({ success: true, message: 'Login successful.' });
      });
    });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password.' });
  }
});

adminRouter.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('hawza.sid');
    res.json({ success: true, message: 'Logout successful.' });
  });
});

adminRouter.get('/status', requireAuth, (req, res) => {
  res.json({ success: true, data: { authenticated: true } });
});

adminRouter.get('/questions', requireAuth, async (req, res, next) => {
  try {
    const data = await loadQuestions();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/question', requireAuth, async (req, res, next) => {
  try {
    const { question, source = '', tags = [], answer = '' } = req.body;
    if (!question?.trim()) {
      return res.status(400).json({ success: false, error: 'Question text is required.' });
    }
    const all = await loadQuestions();
    const newQ = {
      id: crypto.randomUUID(),
      question: question.trim(),
      source: source.trim(),
      tags,
      answer,
      date: new Date().toISOString(),
      answeredDate: answer.trim() ? new Date().toISOString() : null
    };
    all.unshift(newQ);
    await saveQuestions(all);
    res.status(201).json({ success: true, data: newQ });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/question/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { question, source = '', tags = [], answer = '' } = req.body;
    if (!question?.trim()) {
      return res.status(400).json({ success: false, error: 'Question text is required.' });
    }
    const all = await loadQuestions();
    const idx = all.findIndex(q => q.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Question not found.' });
    }
    const orig = all[idx];
    const updated = {
      ...orig,
      question: question.trim(),
      source: source.trim(),
      tags,
      answer,
      answeredDate: !orig.answer.trim() && answer.trim() ? new Date().toISOString() : orig.answeredDate
    };
    all[idx] = updated;
    await saveQuestions(all);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/question/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const all = await loadQuestions();
    const filtered = all.filter(q => q.id !== id);
    if (filtered.length === all.length) {
      return res.status(404).json({ success: false, error: 'Question not found.' });
    }
    await saveQuestions(filtered);
    res.json({ success: true, message: 'Question deleted.' });
  } catch (err) {
    next(err);
  }
});

const publicRouter = express.Router();

publicRouter.post('/questions', async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question?.trim() || question.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Question text is invalid or too short.' });
    }
    const all = await loadQuestions();
    const newQ = {
      id: crypto.randomUUID(),
      question: question.trim(),
      source: '',
      tags: [],
      answer: '',
      date: new Date().toISOString(),
      answeredDate: null
    };
    all.unshift(newQ);
    await saveQuestions(all);
    res.status(201).json({ success: true, message: 'Your question has been received.' });
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/answered', async (req, res, next) => {
  try {
    const all = await loadQuestions();
    const answered = all.filter(q => q.answer.trim());
    res.json({ success: true, data: answered });
  } catch (err) {
    next(err);
  }
});

app.use('/api', publicRouter);
app.use('/admin', adminRouter);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'An unexpected server error occurred.' });
});

module.exports.handler = serverless(app);
