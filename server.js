const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
