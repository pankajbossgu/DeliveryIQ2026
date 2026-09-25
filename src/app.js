const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { loadEnvironment } = require('./utils');

loadEnvironment();

const app = express();
const publicDirectory = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_ORIGIN || false, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/health', (request, response) => {
  response.status(200).json({ status: 'ok', service: 'deliveryiq', timestamp: new Date().toISOString() });
});

app.use(express.static(publicDirectory));

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.get('*', (request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

module.exports = app;
