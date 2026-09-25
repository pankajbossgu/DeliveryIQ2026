const path = require('node:path');
const zlib = require('node:zlib');
const { classifyProduct, classifyStatus } = require('./classification');

const MAX_SOURCE_ROWS = 50000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const DELIVERYIQ_COLUMNS = [
  ['order_id', 'Order ID', ['order id', 'orderid', 'order_id', 'order number', 'order no']],
  ['order_date', 'Order Date', ['order date', 'orderdate', 'order_date']],
  ['status', 'Status', ['status', 'delivery status', 'shipping status', 'order status']],
  ['product_name', 'Product Name', ['product name', 'productname', 'product_name', 'product', 'item name']],
  ['quantity', 'Order Quantity', ['order quantity', 'orderquantity', 'order_quantity', 'quantity', 'qty']],
  ['payment_mode', 'Payment Mode', ['payment mode', 'paymentmode', 'payment_mode', 'payment method']],
  ['order_source', 'Order Source', ['order source', 'ordersource', 'order_source', 'source', 'sales channel']]
].map(([key, label, aliases]) => ({ key, label, required: true, aliases }));

function normalizeColumnName(value) { return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim(); }
function error(code, message, details = {}, status = 422) { return { success: false, code, message, details, status }; }
function parseCsv(text) {
  const rows = [[]]; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) { const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { rows.at(-1).push(value); value = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && text[i + 1] === '\n') i += 1; rows.at(-1).push(value); rows.push([]); value = ''; }
    else value += char;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (value || rows.at(-1).length) rows.at(-1).push(value); else rows.pop();
  return rows;
}
function unzip(buffer) {
  const result = new Map(); let cursor = 0;
  while (cursor + 4 <= buffer.length) { const signature = buffer.readUInt32LE(cursor); if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(cursor + 8); const compressedSize = buffer.readUInt32LE(cursor + 18); const nameLength = buffer.readUInt16LE(cursor + 26); const extraLength = buffer.readUInt16LE(cursor + 28);
    if (!compressedSize || (method !== 0 && method !== 8)) throw new Error('Unsupported XLSX archive');
    const name = buffer.subarray(cursor + 30, cursor + 30 + nameLength).toString(); const start = cursor + 30 + nameLength + extraLength; const data = buffer.subarray(start, start + compressedSize);
    result.set(name, method === 8 ? zlib.inflateRawSync(data).toString() : data.toString()); cursor = start + compressedSize;
  } return result;
}
function xmlText(value) { return String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))); }
function columnIndex(reference) { let index = 0; for (const char of reference.replace(/\d/g, '')) index = index * 26 + char.charCodeAt(0) - 64; return index - 1; }
function parseXlsx(buffer) {
  const files = unzip(buffer); const sheet = files.get('xl/worksheets/sheet1.xml'); if (!sheet) throw new Error('Missing first worksheet');
  const sharedStrings = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join('')));
  return [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => { const row = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) { const ref = /r="([A-Z]+\d+)"/.exec(cell[1]); const index = ref ? columnIndex(ref[1]) : row.length; const type = /t="([^"]+)"/.exec(cell[1])?.[1]; const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1] ?? ''; row[index] = type === 's' ? sharedStrings[Number(raw)] ?? '' : xmlText(raw); }
    return row;
  });
}
function classificationSummary(items) { return items.reduce((summary, item) => { if (item.classificationRequired) summary.requiresReview += 1; else if (item.mappingSource === 'client') summary.client += 1; else summary.generic += 1; return summary; }, { generic: 0, client: 0, requiresReview: 0 }); }
function groupedClassifications(values, classifier, mappings) {
  const groups = new Map(); values.forEach((value) => { const key = String(value ?? '').trim(); if (!key) return; const entry = groups.get(key) || { value: key, count: 0 }; entry.count += 1; groups.set(key, entry); });
  return [...groups.values()].map((entry) => ({ ...entry, ...classifier(entry.value, mappings) }));
}
function validateUpload(file, { statusMappings = [], productMappings = [] } = {}) {
  if (!file?.buffer) return error('FILE_REQUIRED', 'Choose a CSV or XLSX file to validate.', {}, 400);
  const type = path.extname(file.originalname || '').toLowerCase().slice(1);
  if (!['csv', 'xlsx'].includes(type)) return error('UNSUPPORTED_FILE_TYPE', 'Only CSV and XLSX files are supported.', { acceptedTypes: ['CSV', 'XLSX'] }, 400);
  if (!file.buffer.length) return error('EMPTY_FILE', 'The uploaded file is empty. Choose a file with a header row and source data.');
  if (file.buffer.length > MAX_FILE_SIZE) return error('FILE_TOO_LARGE', 'The uploaded file is larger than the 10 MB file limit.', { maxBytes: MAX_FILE_SIZE }, 413);
  if (type === 'xlsx' && file.buffer.readUInt32LE(0) !== 0x04034b50) return error('MALFORMED_FILE', 'We could not read this file. Export it again as a CSV or XLSX file and try again.');
  let rows; try { rows = type === 'csv' ? parseCsv(file.buffer.toString('utf8').replace(/^\uFEFF/, '')) : parseXlsx(file.buffer); } catch { return error('MALFORMED_FILE', 'We could not read this file. Export it again as a CSV or XLSX file and try again.'); }
  if (!rows.length || !rows[0]?.some((value) => String(value ?? '').trim())) return error('EMPTY_FILE', 'The uploaded file does not contain a header row.');
  const headers = rows[0].map((value) => String(value ?? '').trim()); const sourceRows = rows.slice(1).filter((row) => row.some((value) => String(value ?? '').trim()));
  if (!sourceRows.length) return error('EMPTY_FILE', 'The uploaded file does not contain any source rows.');
  if (sourceRows.length > MAX_SOURCE_ROWS) return error('ROW_LIMIT_EXCEEDED', 'The uploaded file contains more than 50,000 source rows.', { maxRows: MAX_SOURCE_ROWS, actualRows: sourceRows.length });
  const mapped = {}; DELIVERYIQ_COLUMNS.forEach((column) => { const index = headers.findIndex((header) => column.aliases.map(normalizeColumnName).includes(normalizeColumnName(header))); if (index !== -1) mapped[column.key] = { index, label: column.label, source: headers[index] }; });
  const missingColumns = DELIVERYIQ_COLUMNS.filter((column) => !mapped[column.key]).map((column) => column.label);
  if (missingColumns.length) return error('MISSING_REQUIRED_COLUMNS', "We couldn't find all required columns. Add the missing columns and try again.", { missingColumns, requiredColumns: DELIVERYIQ_COLUMNS.map((column) => column.label), detectedColumns: headers });
  const errors = []; const warnings = []; const seen = new Set(); const duplicates = []; const orders = new Set(); const products = new Set(); const statuses = new Set();
  sourceRows.forEach((row, offset) => { const rowNumber = offset + 2; const get = (key) => String(row[mapped[key].index] ?? '').trim(); const order = get('order_id'); const product = get('product_name'); const status = get('status'); const qty = get('quantity');
    [['Order ID', order], ['Order Date', get('order_date')], ['Status', status], ['Product Name', product], ['Payment Mode', get('payment_mode')], ['Order Source', get('order_source')]].forEach(([field, value]) => { if (!value) errors.push({ row: rowNumber, field, message: `${field} is required.` }); });
    if (!/^\d+$/.test(qty) || Number(qty) < 1) errors.push({ row: rowNumber, field: 'Order Quantity', message: 'Order Quantity must be a positive whole number.' });
    const signature = DELIVERYIQ_COLUMNS.map((column) => get(column.key).toLowerCase()).join('\u001f'); if (seen.has(signature)) duplicates.push(rowNumber); else seen.add(signature); if (order) orders.add(order); if (product) products.add(product); if (status) statuses.add(status);
  });
  if (duplicates.length) warnings.push({ code: 'DUPLICATE_SOURCE_ROWS', message: `${duplicates.length} duplicate source row${duplicates.length === 1 ? '' : 's'} detected. No data was removed.`, count: duplicates.length, sampleRows: duplicates.slice(0, 10) });
  if (errors.length) return error('INVALID_ROWS', 'Some rows need attention before you can continue.', { errors: errors.slice(0, 100), errorCount: errors.length, warnings });
  const statusClassifications = groupedClassifications(sourceRows.map((row) => String(row[mapped.status.index] ?? '').trim()), classifyStatus, statusMappings);
  const productClassifications = groupedClassifications(sourceRows.map((row) => String(row[mapped.product_name.index] ?? '').trim()), classifyProduct, productMappings);
  return { success: true, file: { name: path.basename(file.originalname), type, rows: sourceRows.length }, columns: { detected: headers, mapped: Object.fromEntries(Object.entries(mapped).map(([key, column]) => [key, { label: column.label, source: column.source }])) }, validation: { valid: true, errors: [], warnings, duplicates: duplicates.length }, summary: { sourceRows: sourceRows.length, uniqueOrders: orders.size, productRows: sourceRows.length, detectedStatuses: statuses.size, detectedProducts: products.size }, classifications: { statuses: statusClassifications, products: productClassifications, statusSummary: classificationSummary(statusClassifications), productSummary: classificationSummary(productClassifications) } };
}
function csvTemplate() { const rows = [DELIVERYIQ_COLUMNS.map((column) => column.label), ['ORD-SAMPLE-1001', '2026-01-15', 'Delivered', 'Classic Cotton Tee', '1', 'Prepaid', 'Demo Store'], ['ORD-SAMPLE-1002', '2026-01-16', 'Out for Delivery', 'Travel Bottle Set', '2', 'COD', 'Demo Store']]; return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
module.exports = { DELIVERYIQ_COLUMNS, MAX_FILE_SIZE, MAX_SOURCE_ROWS, csvTemplate, normalizeColumnName, validateUpload };
function xlsxTemplate() {
  const rows = [DELIVERYIQ_COLUMNS.map((c) => c.label), ['ORD-SAMPLE-1001', '2026-01-15', 'Delivered', 'Classic Cotton Tee', '1', 'Prepaid', 'Demo Store'], ['ORD-SAMPLE-1002', '2026-01-16', 'Out for Delivery', 'Travel Bottle Set', '2', 'COD', 'Demo Store']];
  const escape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'); const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('');
  const files = { '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Upload template" sheetId="1" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` };
  const crc = (b) => { let c = -1; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ -1) >>> 0; }; let offset = 0; const locals = []; const central = [];
  for (const [name, contents] of Object.entries(files)) { const body = Buffer.from(contents); const n = Buffer.from(name); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(body), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26); locals.push(h, n, body); const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt32LE(crc(body), 16); d.writeUInt32LE(body.length, 20); d.writeUInt32LE(body.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(offset, 42); central.push(d, n); offset += 30 + n.length + body.length; }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
module.exports.xlsxTemplate = xlsxTemplate;
