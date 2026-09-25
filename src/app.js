const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { loadEnvironment } = require('./utils');
const { MAX_FILE_SIZE, csvTemplate, validateUpload, xlsxTemplate } = require('./upload');
const { REPORT_CATEGORIES } = require('./classification');
const { MappingStore } = require('./mappings');

loadEnvironment();

const app = express();
const publicDirectory = path.join(__dirname, '..', 'public');
const mappingStore = new MappingStore();
// Authentication is not introduced yet. The server-owned demo scope deliberately avoids trusting a browser tenant identifier.
const clientId = process.env.DEFAULT_CLIENT_ID || 'demo-client';
const productCategories = (process.env.PRODUCT_CATEGORIES || 'Apparel,Beauty,Electronics,Home,Other').split(',').map((category) => category.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(cors({ origin: process.env.APP_ORIGIN || false, credentials: true }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/health', (request, response) => {
  response.status(200).json({ status: 'ok', service: 'deliveryiq', timestamp: new Date().toISOString() });
});

app.get('/api/uploads/template.csv', (request, response) => {
  response.attachment('deliveryiq-upload-template.csv').type('text/csv').send(csvTemplate());
});
app.get('/api/uploads/template.xlsx', (request, response) => {
  response.attachment('deliveryiq-upload-template.xlsx').type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(xlsxTemplate());
});
app.post('/api/uploads/validate', express.raw({ type: 'application/octet-stream', limit: MAX_FILE_SIZE }), async (request, response) => {
  const name = request.get('x-file-name');
  if (!name) return response.status(400).json({ success: false, code: 'FILE_REQUIRED', message: 'Choose a CSV or XLSX file to validate.', details: {} });
  const [statusMappings, productMappings] = await Promise.all([mappingStore.list('status', clientId), mappingStore.list('product', clientId)]);
  const result = validateUpload({ originalname: name, buffer: request.body }, { statusMappings, productMappings });
  return response.status(result.success ? 200 : result.status).json(result);
});
app.get('/api/classifications/config', (request, response) => response.json({ statusCategories: REPORT_CATEGORIES, productCategories }));
app.post('/api/mappings/:kind', async (request, response) => {
  const kind = request.params.kind;
  if (!['status', 'product'].includes(kind)) return response.status(404).json({ error: 'Not found' });
  const value = kind === 'status' ? request.body?.status : request.body?.product;
  const allowedCategories = kind === 'status' ? REPORT_CATEGORIES : productCategories;
  if (!allowedCategories.includes(request.body?.category) || !String(value ?? '').trim()) return response.status(422).json({ success: false, code: 'INVALID_MAPPING', message: 'Choose a valid category and a value to map.' });
  try { const mapping = await mappingStore.save(kind, clientId, value, request.body.category); return response.status(200).json({ success: true, mapping }); }
  catch (error) { return response.status(422).json({ success: false, code: error.code || 'INVALID_MAPPING', message: 'We could not save that mapping. Please try again.' }); }
});
app.use((error, request, response, next) => {
  if (error?.type === 'entity.too.large') return response.status(413).json({ success: false, code: 'FILE_TOO_LARGE', message: 'The uploaded file is larger than the 10 MB file limit.', details: { maxBytes: MAX_FILE_SIZE } });
  return next(error);
});

app.use(express.static(publicDirectory));

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.get('*', (request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

module.exports = app;
