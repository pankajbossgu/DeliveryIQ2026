const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');

test('health endpoint confirms the application is available', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'deliveryiq');
    assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('application shell is served with the planned product navigation', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Upload Data/);
    assert.match(page, /Product Mapping/);
    assert.match(page, /Status Mapping/);
    assert.match(page, /Maximum 50,000 rows/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
