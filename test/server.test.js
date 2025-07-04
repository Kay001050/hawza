const { spawn } = require('child_process');
const fs = require('fs');
const assert = require('assert');
const { test } = require('node:test');

const PORT = 3210;

function startServer() {
  return spawn('node', ['server.js'], { env: { ...process.env, PORT } });
}

test('POST and GET questions', async (t) => {
  fs.writeFileSync('data/questions.json', '[]', 'utf8');
  const server = startServer();
  await new Promise(res => setTimeout(res, 500));

  const postRes = await fetch(`http://localhost:${PORT}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'test?' })
  });
  assert.strictEqual(postRes.status, 201);
  const { entry } = await postRes.json();
  assert.ok(entry.id);

  const getRes = await fetch(`http://localhost:${PORT}/api/questions`);
  assert.strictEqual(getRes.status, 200);
  const list = await getRes.json();
  assert.ok(Array.isArray(list));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].question, 'test?');

  server.kill();
});
