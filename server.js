require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data', 'questions.json');

function loadQuestions() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveQuestions(questions) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf8');
}

app.post('/api/questions', (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Question text required' });
  }
  const questions = loadQuestions();
  const entry = { question, date: new Date().toISOString() };
  questions.push(entry);
  saveQuestions(questions);
  res.status(201).json({ message: 'Question stored', entry });
});

app.get('/api/questions', (_req, res) => {
  const questions = loadQuestions();
  res.json(questions);
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ message: 'Logged in' });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/admin/questions', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(loadQuestions());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
