const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { normalizeOrderId } = require('./upload');
const CATEGORIES = ['Delivered', 'In Transit', 'NDR', 'RTO', 'Cancelled', 'Other'];
const rowSchema = new mongoose.Schema({ reportId: { type: String, index: true }, clientId: { type: String, index: true }, orderId: String, normalizedOrderId: String, orderDate: String, category: String, originalStatus: String, normalizedStatus: String, originalProductName: String, normalizedProductName: String, masterCategory: String, productCategory: String, paymentMode: String, courier: String, orderSource: String, quantity: Number, productPrice: Number, rowValue: Number }, { versionKey: false });
rowSchema.index({ clientId: 1, reportId: 1, orderDate: 1 });
const reportSchema = new mongoose.Schema({ reportId: { type: String, unique: true }, clientId: { type: String, index: true }, requestId: { type: String }, reportName: String, templateType: String, sourceFileName: String, sourceRowCount: Number, uniqueOrderCount: Number, reportStatus: String, createdAt: Date, completedAt: Date, summary: Object, dateRange: Object, availableDimensions: [String], analytics: Object }, { versionKey: false });
reportSchema.index({ clientId: 1, createdAt: -1 }); reportSchema.index({ clientId: 1, requestId: 1 }, { unique: true, sparse: true });
const Report = mongoose.models.Report || mongoose.model('Report', reportSchema); const ReportRow = mongoose.models.ReportRow || mongoose.model('ReportRow', rowSchema);

// UniversalOrder is the tenant-scoped latest projection; UniversalOrderOccurrence is immutable
// report evidence; UniversalSync is the idempotent completed-report synchronization ledger.
const universalLineSchema = new mongoose.Schema({ originalProductName: String, normalizedProductName: String, masterCategory: String, productCategory: String, quantity: Number, productPrice: Number, rowValue: Number }, { _id: false });
const universalOrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, canonicalOrderId: { type: String, required: true }, originalOrderId: String,
  latestReportId: { type: String, required: true }, latestReportCompletedAt: { type: Date, required: true },
  orderDate: String, originalStatus: String, normalizedStatus: String, statusCategory: String,
  paymentMode: String, courier: String, orderSource: String, products: { type: [universalLineSchema], default: [] },
  totalQuantity: Number, totalValue: Number
}, { timestamps: true, versionKey: false });
universalOrderSchema.index({ clientId: 1, canonicalOrderId: 1 }, { unique: true });
universalOrderSchema.index({ clientId: 1, latestReportCompletedAt: -1 });
// These match the two date-filtered current-order analytics views. Product lines
// are aggregated only after the tenant/date match, so no multikey index is needed.
universalOrderSchema.index({ clientId: 1, orderDate: 1 });
universalOrderSchema.index({ clientId: 1, statusCategory: 1 });
universalOrderSchema.index({ clientId: 1, originalStatus: 1 });
const universalOccurrenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true, immutable: true }, canonicalOrderId: { type: String, required: true, immutable: true }, originalOrderId: String,
  reportId: { type: String, required: true, immutable: true }, reportCompletedAt: { type: Date, required: true, immutable: true },
  orderDate: String, originalStatus: String, normalizedStatus: String, statusCategory: String,
  paymentMode: String, courier: String, orderSource: String, products: { type: [universalLineSchema], default: [] },
  totalQuantity: Number, totalValue: Number, sourceFileName: String, templateType: String
}, { timestamps: true, versionKey: false });
universalOccurrenceSchema.index({ clientId: 1, reportId: 1, canonicalOrderId: 1 }, { unique: true });
// Serves tenant-scoped history's deterministic completion-time/report-ID ordering.
universalOccurrenceSchema.index({ clientId: 1, canonicalOrderId: 1, reportCompletedAt: -1, reportId: -1 });
const universalSyncSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, reportId: { type: String, required: true },
  status: { type: String, required: true, enum: ['processing', 'completed', 'failed'] }, startedAt: Date, completedAt: Date,
  error: { type: String, maxlength: 500 }, counts: { ordersProcessed: { type: Number, default: 0 }, occurrencesCreated: { type: Number, default: 0 }, ordersInserted: { type: Number, default: 0 }, ordersUpdated: { type: Number, default: 0 }, skippedDuplicateObservations: { type: Number, default: 0 } }
}, { timestamps: true, versionKey: false });
universalSyncSchema.index({ clientId: 1, reportId: 1 }, { unique: true });
universalSyncSchema.index({ clientId: 1, status: 1, updatedAt: -1 });
const UniversalOrder = mongoose.models.UniversalOrder || mongoose.model('UniversalOrder', universalOrderSchema, 'universalOrders');
const UniversalOrderOccurrence = mongoose.models.UniversalOrderOccurrence || mongoose.model('UniversalOrderOccurrence', universalOccurrenceSchema, 'universalOrderOccurrences');
const UniversalSync = mongoose.models.UniversalSync || mongoose.model('UniversalSync', universalSyncSchema, 'universalSyncs');
function percent(value, total) { return total ? Number((value * 100 / total).toFixed(2)) : 0; }
function canonicalRows(rows) { const byOrder = new Map(); rows.forEach((row) => { const key = row.normalizedOrderId || row.orderId; if (!byOrder.has(key)) byOrder.set(key, row); }); return [...byOrder.values()]; }
function dimensions(templateType) { return templateType === 'full' ? ['date', 'masterCategory', 'product', 'productCategory', 'paymentMode', 'courier', 'orderSource'] : ['date', 'masterCategory', 'product', 'productCategory', 'paymentMode']; }
function aggregate(rows, templateType) { const orders = canonicalRows(rows); const summary = Object.fromEntries(CATEGORIES.map((category) => [category, 0])); orders.forEach((row) => { if (summary[row.category] !== undefined) summary[row.category] += 1; }); const totalOrders = orders.length; const group = (key) => Object.values(rows.reduce((out, row) => { const value = row[key]; if (!value) return out; const bucket = out[value] || (out[value] = { name: value, rows: [] }); bucket.rows.push(row); return out; }, {})).map((bucket) => ({ name: bucket.name, ...metric(bucket.rows) })); const metric = (source) => { const unique = canonicalRows(source); const counts = Object.fromEntries(CATEGORIES.map((category) => [category, unique.filter((row) => row.category === category).length])); const base = { orders: unique.length, ...counts, deliveryPercent: percent(counts.Delivered, unique.length), ndrPercent: percent(counts.NDR, unique.length), rtoPercent: percent(counts.RTO, unique.length) }; if (templateType === 'full') { base.quantity = source.reduce((sum, row) => sum + (row.quantity || 0), 0); base.revenue = Number(source.reduce((sum, row) => sum + (row.rowValue || 0), 0).toFixed(2)); } return base; };
  const analytics = { statusDistribution: { totalOrders, ...summary, percentages: Object.fromEntries(CATEGORIES.map((c) => [c, percent(summary[c], totalOrders)])) }, date: group('orderDate'), masterCategory: group('masterCategory'), product: group('originalProductName'), productCategory: group('productCategory'), paymentMode: group('paymentMode') }; if (templateType === 'full') { analytics.courier = group('courier'); analytics.orderSource = group('orderSource'); analytics.revenue = Number(rows.reduce((sum, row) => sum + (row.rowValue || 0), 0).toFixed(2)); } return { totalOrders, summary, analytics }; }
function applyFilters(rows, filters = {}, templateType) { const allowed = new Set(dimensions(templateType)); const field = { date: 'orderDate', category: 'category', masterCategory: 'masterCategory', product: 'originalProductName', productCategory: 'productCategory', paymentMode: 'paymentMode', courier: 'courier', orderSource: 'orderSource' }; return rows.filter((row) => { if (filters.from && row.orderDate < filters.from || filters.to && row.orderDate > filters.to) return false; return Object.entries(filters).every(([key, value]) => { if (!value || ['from', 'to'].includes(key)) return true; if (!allowed.has(key) && key !== 'category') return false; return String(row[field[key]] || '') === String(value); }); }); }
function safeCell(value) { if (typeof value === 'number' && Number.isFinite(value)) return String(value); const text = String(value ?? ''); return /^[=+\-@]/.test(text) ? `'${text}` : text; }
function csv(rows, templateType) { const headers = ['Order ID', 'Order Date', 'Actual Status', 'Status Category', 'Product Name', 'Master Category', 'Product Category', 'Payment Mode', ...(templateType === 'full' ? ['Product Qty', 'Product Price', 'Revenue', 'Courier', 'Source/Website/Store'] : [])]; const values = rows.map((row) => [row.orderId, row.orderDate, row.originalStatus, row.category, row.originalProductName, row.masterCategory, row.productCategory, row.paymentMode, ...(templateType === 'full' ? [row.quantity, row.productPrice, row.rowValue, row.courier, row.orderSource] : [])]); return [headers, ...values].map((line) => line.map((cell) => `"${safeCell(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
const UNIVERSAL_EXPORT_HEADERS = ['Order ID', 'Order Date', 'Actual Status', 'Status Category', 'Product Name', 'Master Category', 'Product Category', 'Product Quantity', 'Product Price', 'Product Value', 'Order Quantity', 'Order Value', 'Latest Report ID', 'Latest Report Completed At'];
function csvLine(values) { return `${values.map((cell) => `"${safeCell(cell).replace(/"/g, '""')}"`).join(',')}\r\n`; }
function universalExportRows(order) {
  // One CSV record per persisted product line preserves multi-product current orders.
  const lines = order.products?.length ? order.products : [{}];
  return lines.map((line) => [order.canonicalOrderId || order.originalOrderId, order.orderDate, order.originalStatus, order.statusCategory, line.originalProductName || line.normalizedProductName, line.masterCategory, line.productCategory, line.quantity, line.productPrice, line.rowValue, order.totalQuantity, order.totalValue, order.latestReportId, order.latestReportCompletedAt instanceof Date ? order.latestReportCompletedAt.toISOString() : order.latestReportCompletedAt]);
}
function universalProjection(report, canonicalOrderId, rows) {
  const first = rows[0]; const products = rows.map((row) => ({ originalProductName: row.originalProductName, normalizedProductName: row.normalizedProductName, masterCategory: row.masterCategory || null, productCategory: row.productCategory || null, quantity: row.quantity ?? null, productPrice: row.productPrice ?? null, rowValue: row.rowValue ?? null }));
  return { clientId: report.clientId, canonicalOrderId, originalOrderId: first.orderId || first.originalOrderId, latestReportId: report.reportId, latestReportCompletedAt: report.completedAt, orderDate: first.orderDate, originalStatus: first.originalStatus, normalizedStatus: first.normalizedStatus, statusCategory: first.category, paymentMode: first.paymentMode, courier: first.courier, orderSource: first.orderSource, products, totalQuantity: products.reduce((total, line) => total + (line.quantity || 0), 0), totalValue: Number(products.reduce((total, line) => total + (line.rowValue || 0), 0).toFixed(2)) };
}
function groupUniversalRows(rows) { const grouped = new Map(); for (const row of rows) { const canonicalOrderId = normalizeOrderId(row.normalizedOrderId || row.orderId || row.originalOrderId); if (!canonicalOrderId) continue; const values = grouped.get(canonicalOrderId) || []; values.push(row); grouped.set(canonicalOrderId, values); } return grouped; }
function isLaterProjection(existing, candidate) { const currentTime = new Date(existing.latestReportCompletedAt).getTime(); const candidateTime = new Date(candidate.latestReportCompletedAt).getTime(); return candidateTime > currentTime || candidateTime === currentTime && String(candidate.latestReportId) > String(existing.latestReportId); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function dateRange(from, to) { const range = {}; if (from) range.$gte = from; if (to) range.$lte = to; return range; }
function universalSort(sortBy, direction, defaultField) { const field = sortBy || defaultField; const value = direction === 'asc' ? 1 : -1; return field === 'canonicalOrderId' ? { canonicalOrderId: value } : { [field]: value, canonicalOrderId: 1 }; }
function memorySort(sort) { const entries = Object.entries(sort); return (left, right) => { for (const [field, direction] of entries) { const a = left[field] instanceof Date ? left[field].getTime() : left[field]; const b = right[field] instanceof Date ? right[field].getTime() : right[field]; if (a === b) continue; if (a === undefined || a === null) return -direction; if (b === undefined || b === null) return direction; return a > b ? direction : -direction; } return 0; }; }
function matchesUniversal(item, filters) { const completed = item.latestReportCompletedAt || item.reportCompletedAt; return (!filters.search || item.canonicalOrderId.toLowerCase().startsWith(filters.search.toLowerCase())) && (!filters.status || item.originalStatus === filters.status) && (!filters.statusCategory || item.statusCategory === filters.statusCategory) && (!filters.fromDate || item.orderDate >= filters.fromDate) && (!filters.toDate || item.orderDate <= filters.toDate) && (!filters.reportFromDate || new Date(completed) >= new Date(filters.reportFromDate)) && (!filters.reportToDate || new Date(completed) <= new Date(filters.reportToDate)); }
function buckets(items, field) { return Object.fromEntries(items.filter((item) => item._id).map((item) => [item._id, item.count])); }
function summaryFromBuckets(summary) { const total = summary.totals?.[0] || {}; return { totalOrders: total.totalOrders || 0, totalValue: Number((total.totalValue || 0).toFixed(2)), totalQuantity: total.totalQuantity || 0, byStatusCategory: buckets(summary.byStatusCategory || []), byStatus: buckets(summary.byStatus || []) }; }
function summaryFromOrders(orders) { const group = (field) => orders.reduce((result, order) => { if (order[field]) result[order[field]] = (result[order[field]] || 0) + 1; return result; }, {}); return { totalOrders: orders.length, totalValue: Number(orders.reduce((total, order) => total + (order.totalValue || 0), 0).toFixed(2)), totalQuantity: orders.reduce((total, order) => total + (order.totalQuantity || 0), 0), byStatusCategory: group('statusCategory'), byStatus: group('originalStatus') }; }
function universalFilter(clientId, { search, status, statusCategory, fromDate, toDate, reportFromDate, reportToDate } = {}) { const filter = { clientId }; if (search) filter.canonicalOrderId = { $regex: `^${escapeRegex(search)}`, $options: 'i' }; if (status) filter.originalStatus = status; if (statusCategory) filter.statusCategory = statusCategory; if (fromDate || toDate) filter.orderDate = dateRange(fromDate, toDate); if (reportFromDate || reportToDate) filter.latestReportCompletedAt = dateRange(reportFromDate, reportToDate); return filter; }
function analyticsFromOrders(orders) { const summary = summaryFromOrders(orders); const total = summary.totalOrders; const grouped = (field) => Object.entries(summary[field] || {}).map(([name, count]) => ({ name, count, percentage: percent(count, total) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); const trendMap = new Map(); const productMap = new Map(); orders.forEach((order) => { if (order.orderDate) { const item = trendMap.get(order.orderDate) || { date: order.orderDate, count: 0, value: 0 }; item.count += 1; item.value += Number(order.totalValue || 0); trendMap.set(order.orderDate, item); } (order.products || []).forEach((line) => { const name = line.originalProductName || line.normalizedProductName || 'Unmapped product'; const item = productMap.get(name) || { name, quantity: 0, value: 0, orderIds: new Set() }; item.quantity += Number(line.quantity || 0); item.value += Number(line.rowValue || 0); item.orderIds.add(order.canonicalOrderId); productMap.set(name, item); }); }); const products = [...productMap.values()].map((item) => ({ name: item.name, quantity: item.quantity, value: Number(item.value.toFixed(2)), orderCount: item.orderIds.size })).sort((a, b) => b.quantity - a.quantity || b.value - a.value || a.name.localeCompare(b.name)).slice(0, 10); const rto = (summary.byStatusCategory.RTO || 0); return { summary: { ...summary, rtoOrders: rto, rtoPercentage: percent(rto, total), rtoValue: Number(orders.filter((order) => order.statusCategory === 'RTO').reduce((sum, order) => sum + Number(order.totalValue || 0), 0).toFixed(2)) }, statusCategories: grouped('byStatusCategory'), statuses: grouped('byStatus'), trends: [...trendMap.values()].map((item) => ({ ...item, value: Number(item.value.toFixed(2)) })).sort((a, b) => a.date.localeCompare(b.date)), products, attention: rto ? [{ type: 'RTO', count: rto, percentage: percent(rto, total), value: Number(orders.filter((order) => order.statusCategory === 'RTO').reduce((sum, order) => sum + Number(order.totalValue || 0), 0).toFixed(2)) }] : [] }; }
class UniversalStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) { this.mongoUri = mongoUri; this.connection = null; this.orders = new Map(); this.occurrences = new Map(); this.syncs = new Map(); }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  key(clientId, value) { return `${clientId}\u001f${value}`; }
  // These read methods are deliberately the only public Universal API surface. Filters
  // are built by the HTTP layer from an allow-list; every database predicate starts
  // with the server-resolved clientId.
  async listOrders(clientId, { page, limit, search, status, statusCategory, fromDate, toDate, reportFromDate, reportToDate, sortBy, sortDirection }) {
    const filter = universalFilter(clientId, { search, status, statusCategory, fromDate, toDate, reportFromDate, reportToDate });
    const sort = universalSort(sortBy, sortDirection, 'latestReportCompletedAt');
    if (await this.database()) {
      const listProjection = { clientId: 0, products: 0, paymentMode: 0, courier: 0, orderSource: 0 };
      const [orders, total] = await Promise.all([UniversalOrder.find(filter, listProjection).sort(sort).skip((page - 1) * limit).limit(limit).lean(), UniversalOrder.countDocuments(filter)]);
      return { orders, total };
    }
    const orders = [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, { search, status, statusCategory, fromDate, toDate, reportFromDate, reportToDate })).sort(memorySort(sort));
    return { orders: orders.slice((page - 1) * limit, page * limit), total: orders.length };
  }
  async exportCurrentOrders(clientId, filters, { maxOrders = 50000 } = {}) {
    const filter = universalFilter(clientId, filters);
    const sort = universalSort(filters.sortBy, filters.sortDirection, 'latestReportCompletedAt');
    if (await this.database()) {
      const total = await UniversalOrder.countDocuments(filter);
      if (total > maxOrders) return { total, overLimit: true };
      const cursor = UniversalOrder.find(filter).select({ canonicalOrderId: 1, originalOrderId: 1, orderDate: 1, originalStatus: 1, statusCategory: 1, products: 1, totalQuantity: 1, totalValue: 1, latestReportId: 1, latestReportCompletedAt: 1 }).sort(sort).lean().cursor({ batchSize: 500 });
      return { total, orders: cursor };
    }
    const orders = [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters)).sort(memorySort(sort));
    if (orders.length > maxOrders) return { total: orders.length, overLimit: true };
    return { total: orders.length, orders };
  }
  async orderDetail(clientId, canonicalOrderId) {
    if (await this.database()) return UniversalOrder.findOne({ clientId, canonicalOrderId }).lean();
    return this.orders.get(this.key(clientId, canonicalOrderId)) || null;
  }
  async orderHistory(clientId, canonicalOrderId, { page, limit, fromDate, toDate, reportFromDate, reportToDate }) {
    const filter = { clientId, canonicalOrderId };
    if (fromDate || toDate) filter.orderDate = dateRange(fromDate, toDate);
    if (reportFromDate || reportToDate) filter.reportCompletedAt = dateRange(reportFromDate, reportToDate);
    const sort = { reportCompletedAt: -1, reportId: -1 };
    if (await this.database()) {
      const [occurrences, total] = await Promise.all([UniversalOrderOccurrence.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), UniversalOrderOccurrence.countDocuments(filter)]);
      return { occurrences, total };
    }
    const occurrences = [...this.occurrences.values()].filter((item) => item.clientId === clientId && item.canonicalOrderId === canonicalOrderId && matchesUniversal(item, { fromDate, toDate, reportFromDate, reportToDate })).sort(memorySort(sort));
    return { occurrences: occurrences.slice((page - 1) * limit, page * limit), total: occurrences.length };
  }
  async summary(clientId, filters = {}) {
    const filter = universalFilter(clientId, filters);
    if (await this.database()) {
      const [summary] = await UniversalOrder.aggregate([{ $match: filter }, { $facet: {
        totals: [{ $group: { _id: null, totalOrders: { $sum: 1 }, totalValue: { $sum: { $ifNull: ['$totalValue', 0] } }, totalQuantity: { $sum: { $ifNull: ['$totalQuantity', 0] } } } }],
        byStatusCategory: [{ $group: { _id: '$statusCategory', count: { $sum: 1 } } }], byStatus: [{ $group: { _id: '$originalStatus', count: { $sum: 1 } } }]
      } }]);
      return summaryFromBuckets(summary || {});
    }
    const orders = [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters));
    return summaryFromOrders(orders);
  }
  async analytics(clientId, filters = {}) {
    const filter = universalFilter(clientId, filters);
    if (await this.database()) {
      const [result] = await UniversalOrder.aggregate([{ $match: filter }, { $facet: {
        totals: [{ $group: { _id: null, totalOrders: { $sum: 1 }, totalValue: { $sum: { $ifNull: ['$totalValue', 0] } }, totalQuantity: { $sum: { $ifNull: ['$totalQuantity', 0] } }, rtoOrders: { $sum: { $cond: [{ $eq: ['$statusCategory', 'RTO'] }, 1, 0] } }, rtoValue: { $sum: { $cond: [{ $eq: ['$statusCategory', 'RTO'] }, { $ifNull: ['$totalValue', 0] }, 0] } } } }],
        // Facets are intentionally bounded; products are reduced to the top ten after grouping.
        statusCategories: [{ $group: { _id: '$statusCategory', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
        statuses: [{ $group: { _id: '$originalStatus', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
        trends: [{ $match: { orderDate: { $type: 'string', $ne: '' } } }, { $group: { _id: '$orderDate', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$totalValue', 0] } } } }, { $sort: { _id: 1 } }],
        products: [{ $unwind: '$products' }, { $group: { _id: { name: { $ifNull: ['$products.originalProductName', '$products.normalizedProductName'] }, orderId: '$canonicalOrderId' }, quantity: { $sum: { $ifNull: ['$products.quantity', 0] } }, value: { $sum: { $ifNull: ['$products.rowValue', 0] } } } }, { $group: { _id: '$_id.name', quantity: { $sum: '$quantity' }, value: { $sum: '$value' }, orderCount: { $sum: 1 } } }, { $sort: { quantity: -1, value: -1, _id: 1 } }, { $limit: 10 }]
      } }]);
      const total = result?.totals?.[0] || {}; const totalOrders = total.totalOrders || 0;
      const breakdown = (items) => (items || []).filter((item) => item._id).map((item) => ({ name: item._id, count: item.count, percentage: percent(item.count, totalOrders) }));
      const summary = { totalOrders, totalValue: Number((total.totalValue || 0).toFixed(2)), totalQuantity: total.totalQuantity || 0, byStatusCategory: buckets(result?.statusCategories || []), byStatus: buckets(result?.statuses || []), rtoOrders: total.rtoOrders || 0, rtoPercentage: percent(total.rtoOrders || 0, totalOrders), rtoValue: Number((total.rtoValue || 0).toFixed(2)) };
      return { summary, statusCategories: breakdown(result?.statusCategories), statuses: breakdown(result?.statuses), trends: (result?.trends || []).map((item) => ({ date: item._id, count: item.count, value: Number((item.value || 0).toFixed(2)) })), products: (result?.products || []).map((item) => ({ name: item._id || 'Unmapped product', quantity: item.quantity || 0, value: Number((item.value || 0).toFixed(2)), orderCount: item.orderCount || 0 })), attention: total.rtoOrders ? [{ type: 'RTO', count: total.rtoOrders, percentage: percent(total.rtoOrders, totalOrders), value: Number((total.rtoValue || 0).toFixed(2)) }] : [] };
    }
    return analyticsFromOrders([...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters)));
  }
  async markFailed(clientId, reportId) {
    const error = 'Universal report synchronization could not be completed.';
    if (await this.database()) {
      await UniversalSync.updateOne({ clientId, reportId }, { $set: { status: 'failed', error }, $setOnInsert: { clientId, reportId, startedAt: new Date(), counts: { ordersProcessed: 0, occurrencesCreated: 0, ordersInserted: 0, ordersUpdated: 0, skippedDuplicateObservations: 0 } } }, { upsert: true });
      return { clientId, reportId, status: 'failed', error };
    }
    const key = this.key(clientId, reportId); const prior = this.syncs.get(key);
    const failed = { ...(prior || {}), clientId, reportId, status: 'failed', error, counts: prior?.counts || { ordersProcessed: 0, occurrencesCreated: 0, ordersInserted: 0, ordersUpdated: 0, skippedDuplicateObservations: 0 } };
    this.syncs.set(key, failed); return failed;
  }
  async syncCompletedReport(clientId, report, rows) {
    if (!report || report.clientId !== clientId || report.reportStatus !== 'completed' || !report.completedAt) return { status: 'skipped' };
    console.info(JSON.stringify({ event: 'universal_sync_started', clientId, reportId: report.reportId, orders: groupUniversalRows(rows).size }));
    const syncKey = this.key(clientId, report.reportId); const emptyCounts = { ordersProcessed: 0, occurrencesCreated: 0, ordersInserted: 0, ordersUpdated: 0, skippedDuplicateObservations: 0 };
    if (await this.database()) return this.syncMongo(clientId, report, rows, emptyCounts);
    const prior = this.syncs.get(syncKey); if (prior?.status === 'completed') return { ...prior, alreadyCompleted: true };
    const sync = { clientId, reportId: report.reportId, status: 'processing', startedAt: new Date(), completedAt: null, error: null, counts: { ...emptyCounts } }; this.syncs.set(syncKey, sync);
    try { const groups = groupUniversalRows(rows); sync.counts.ordersProcessed = groups.size;
      for (const [canonicalOrderId, orderRows] of groups) { const occurrenceKey = this.key(clientId, `${report.reportId}\u001f${canonicalOrderId}`); if (this.occurrences.has(occurrenceKey)) { sync.counts.skippedDuplicateObservations += 1; continue; }
        const projection = universalProjection(report, canonicalOrderId, orderRows); this.occurrences.set(occurrenceKey, { ...projection, reportId: report.reportId, reportCompletedAt: report.completedAt, sourceFileName: report.sourceFileName, templateType: report.templateType }); sync.counts.occurrencesCreated += 1;
        const orderKey = this.key(clientId, canonicalOrderId); const existing = this.orders.get(orderKey); if (!existing) { this.orders.set(orderKey, projection); sync.counts.ordersInserted += 1; } else if (isLaterProjection(existing, projection)) { this.orders.set(orderKey, projection); sync.counts.ordersUpdated += 1; }
      } sync.status = 'completed'; sync.completedAt = new Date(); console.info(JSON.stringify({ event: 'universal_sync_completed', clientId, reportId: report.reportId, counts: sync.counts })); return sync;
    } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); return this.markFailed(clientId, report.reportId); }
  }
  async syncMongo(clientId, report, rows, emptyCounts) {
    const existing = await UniversalSync.findOne({ clientId, reportId: report.reportId }).lean(); if (existing?.status === 'completed') return { ...existing, alreadyCompleted: true };
    await UniversalSync.updateOne({ clientId, reportId: report.reportId }, { $set: { status: 'processing', startedAt: new Date(), completedAt: null, error: null }, $setOnInsert: { clientId, reportId: report.reportId, counts: emptyCounts } }, { upsert: true });
    try { const groups = groupUniversalRows(rows); const projections = [...groups.entries()].map(([id, orderRows]) => universalProjection(report, id, orderRows));
      const occurrences = projections.map((projection) => ({ updateOne: { filter: { clientId, reportId: report.reportId, canonicalOrderId: projection.canonicalOrderId }, update: { $setOnInsert: { ...projection, reportId: report.reportId, reportCompletedAt: report.completedAt, sourceFileName: report.sourceFileName, templateType: report.templateType } }, upsert: true } }));
      const occurrenceResult = occurrences.length ? await UniversalOrderOccurrence.bulkWrite(occurrences, { ordered: false }) : { upsertedCount: 0 };
      const initialOrders = projections.map((projection) => ({ updateOne: { filter: { clientId, canonicalOrderId: projection.canonicalOrderId }, update: { $setOnInsert: projection }, upsert: true } }));
      const insertResult = initialOrders.length ? await UniversalOrder.bulkWrite(initialOrders, { ordered: false }) : { upsertedCount: 0 };
      // Latest state is ordered solely by completed-report time, then reportId; order dates never participate.
      const updates = projections.map((projection) => ({ updateOne: { filter: { clientId, canonicalOrderId: projection.canonicalOrderId, $or: [{ latestReportCompletedAt: { $lt: report.completedAt } }, { latestReportCompletedAt: report.completedAt, latestReportId: { $lt: report.reportId } }] }, update: { $set: projection } } }));
      const updateResult = updates.length ? await UniversalOrder.bulkWrite(updates, { ordered: false }) : { modifiedCount: 0 };
      const counts = { ordersProcessed: projections.length, occurrencesCreated: occurrenceResult.upsertedCount || 0, ordersInserted: insertResult.upsertedCount || 0, ordersUpdated: updateResult.modifiedCount || 0, skippedDuplicateObservations: projections.length - (occurrenceResult.upsertedCount || 0) };
      const completed = await UniversalSync.findOneAndUpdate({ clientId, reportId: report.reportId }, { $set: { status: 'completed', completedAt: new Date(), error: null, counts } }, { new: true }).lean();
      console.info(JSON.stringify({ event: 'universal_sync_completed', clientId, reportId: report.reportId, counts })); return completed;
    } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); return this.markFailed(clientId, report.reportId); }
  }
}
function persistedReportRows(clientId, reportId, rows) {
  return rows.map((row) => ({ reportId, clientId, orderId: row.originalOrderId || row.orderId || row.order_id, normalizedOrderId: row.normalizedOrderId || row.orderId || row.order_id, orderDate: row.orderDate || row.order_date, category: row.category, originalStatus: row.originalStatus, normalizedStatus: row.normalizedStatus, originalProductName: row.originalProductName, normalizedProductName: row.normalizedProductName, masterCategory: row.masterCategory, productCategory: row.productCategory, paymentMode: row.paymentMode || row.payment_mode, courier: row.courier, orderSource: row.orderSource || row.order_source, quantity: row.quantity, productPrice: row.productPrice, rowValue: row.rowValue }));
}
class ReportStore {
  constructor({ mongoUri = process.env.MONGODB_URI, universalStore } = {}) { this.mongoUri = mongoUri; this.connection = null; this.memory = new Map(); this.rows = new Map(); this.universalStore = universalStore || new UniversalStore({ mongoUri }); }
  async synchronizeUniversal(clientId, report, rows) { try { return await this.universalStore.syncCompletedReport(clientId, report, rows); } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); if (typeof this.universalStore.markFailed === 'function') { try { return await this.universalStore.markFailed(clientId, report.reportId); } catch { /* The completed report remains authoritative if storage is unavailable. */ } } return { status: 'failed' }; } }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  async retryUniversal(clientId, reportId) {
    const database = await this.database(); const report = database ? await Report.findOne({ clientId, reportId, reportStatus: 'completed' }).lean() : this.memory.get(reportId);
    if (!report || report.clientId !== clientId || report.reportStatus !== 'completed') return { status: 'skipped' };
    const rows = database ? await ReportRow.find({ clientId, reportId }).lean() : this.rows.get(reportId) || [];
    console.info(JSON.stringify({ event: 'universal_sync_retry_started', clientId, reportId, orders: groupUniversalRows(rows).size }));
    return this.synchronizeUniversal(clientId, report, rows);
  }
  async create(clientId, input) {
    const reportId = crypto.randomUUID(); const calculated = aggregate(input.rows, input.templateType); const dates = input.rows.map((row) => row.orderDate || row.order_date).filter(Boolean).sort();
    const report = { reportId, clientId, requestId: input.requestId, reportName: input.reportName || `Delivery Report — ${dates[0] === dates.at(-1) ? dates[0] : `${dates[0]}–${dates.at(-1)}`}`, templateType: input.templateType, sourceFileName: input.sourceFileName, sourceRowCount: input.rows.length, uniqueOrderCount: calculated.totalOrders, reportStatus: 'processing', createdAt: new Date(), completedAt: null, summary: calculated.summary, dateRange: { from: dates[0] || null, to: dates.at(-1) || null }, availableDimensions: dimensions(input.templateType), analytics: calculated.analytics };
    const persistedRows = persistedReportRows(clientId, reportId, input.rows); const database = await this.database();
    if (database) { if (input.requestId) { const existing = await Report.findOne({ clientId, requestId: input.requestId }).lean(); if (existing) return existing; } await Report.create(report); await ReportRow.insertMany(persistedRows); report.reportStatus = 'completed'; report.completedAt = new Date(); await Report.updateOne({ clientId, reportId }, { $set: { reportStatus: report.reportStatus, completedAt: report.completedAt } }); }
    else { if (input.requestId) { const existing = [...this.memory.values()].find((item) => item.clientId === clientId && item.requestId === input.requestId); if (existing) return existing; } this.memory.set(reportId, report); this.rows.set(reportId, persistedRows); report.reportStatus = 'completed'; report.completedAt = new Date(); }
    console.info(JSON.stringify({ event: 'report_completed', clientId, reportId, orders: calculated.totalOrders })); await this.synchronizeUniversal(clientId, report, persistedRows); return report;
  }
  async list(clientId) { if (await this.database()) return Report.find({ clientId, reportStatus: 'completed' }).sort({ createdAt: -1 }).lean(); return [...this.memory.values()].filter((report) => report.clientId === clientId && report.reportStatus === 'completed').sort((a, b) => b.createdAt - a.createdAt); }
  async detail(clientId, reportId, filters = {}) { const report = await (await this.database() ? Report.findOne({ clientId, reportId }).lean() : this.memory.get(reportId)); if (!report || report.clientId !== clientId) return null; const allRows = await (await this.database() ? ReportRow.find({ clientId, reportId }).lean() : this.rows.get(reportId) || []); const rows = applyFilters(allRows, filters, report.templateType); return { ...report, filtered: aggregate(rows, report.templateType), filters: { availableDimensions: report.availableDimensions }, exportRows: rows }; }
}
const ACTIVE_PROCESS_STATUSES = ['queued', 'processing', 'review_required', 'finalizing'];
const processSchema = new mongoose.Schema({
  processId: { type: String, unique: true, index: true }, clientId: { type: String, index: true }, requestId: String,
  status: { type: String, index: true }, stage: String, input: mongoose.Schema.Types.Mixed,
  result: mongoose.Schema.Types.Mixed, report: mongoose.Schema.Types.Mixed, error: String,
  createdAt: Date, updatedAt: Date, cancelledAt: Date
}, { versionKey: false, strict: false });
// The partial unique index is the server-side backstop for two concurrent browser tabs.
processSchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ACTIVE_PROCESS_STATUSES } }, name: 'one_active_report_process_per_client' });
const ReportProcess = mongoose.models.ReportProcess || mongoose.model('ReportProcess', processSchema, 'reportProcesses');
class ProcessingStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) { this.mongoUri = mongoUri; this.connection = null; this.jobs = new Map(); }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 5000 }); return this.connection; }
  public(job) { if (!job) return null; const plain = job.toObject ? job.toObject() : job; const { input, result, ...details } = plain; return { ...details, summary: input.summary, templateType: input.templateType, file: input.file, classifications: result?.classifications || null }; }
  async getActiveProcess(clientId) { if (await this.database()) return ReportProcess.findOne({ clientId, status: { $in: ACTIVE_PROCESS_STATUSES } }).sort({ updatedAt: -1 }).lean(); return [...this.jobs.values()].find((job) => job.clientId === clientId && ACTIVE_PROCESS_STATUSES.includes(job.status)) || null; }
  async createValidated(clientId, input, requestId) {
    const active = await this.getActiveProcess(clientId); if (active) return { job: active, existing: true };
    const job = { processId: crypto.randomUUID(), clientId, requestId: requestId || crypto.randomUUID(), status: 'queued', stage: 'validated', createdAt: new Date(), updatedAt: new Date(), input, result: null, report: null, error: null };
    if (await this.database()) { try { await ReportProcess.create(job); } catch (error) { if (error?.code === 11000) return { job: await this.getActiveProcess(clientId), existing: true }; throw error; } return { job, existing: false }; }
    this.jobs.set(job.processId, job); return { job, existing: false };
  }
  async get(clientId, processId) { if (await this.database()) return ReportProcess.findOne({ clientId, processId }).lean(); const job = this.jobs.get(processId); return job?.clientId === clientId ? job : null; }
  async save(job) { job.updatedAt = new Date(); if (await this.database()) { await ReportProcess.updateOne({ clientId: job.clientId, processId: job.processId }, { $set: job }); } else this.jobs.set(job.processId, job); return job; }
  async start(clientId, processId, execute) { const job = await this.get(clientId, processId); if (!job) return null; const active = await this.getActiveProcess(clientId); if (active && active.processId !== processId) return null; if (!['queued', 'failed'].includes(job.status)) return job; job.status = 'processing'; job.stage = 'preparing_data'; job.error = null; await this.save(job);
    try { job.stage = 'processing_orders'; await this.save(job); const outcome = await execute(job, async (stage) => { job.stage = stage; await this.save(job); }); const result = outcome.result || outcome; job.result = result; if (outcome.report) return this.complete(job, outcome.report); const unresolved = result.classifications.statuses.some((item) => item.classificationRequired) || result.classifications.products.some((item) => item.classificationRequired); job.status = unresolved ? 'review_required' : 'finalizing'; job.stage = unresolved ? 'preparing_review' : 'finalizing_report'; await this.save(job); } catch (error) { job.status = 'failed'; job.stage = 'failed'; job.error = 'Report generation could not be completed.'; await this.save(job); console.warn(JSON.stringify({ event: 'report_processing_failed', processId: job.processId, message: error?.message || 'unknown' })); } return job; }
  async complete(job, report) { job.status = 'completed'; job.stage = 'completed'; job.report = report; return this.save(job); }
  async cancel(clientId, processId) { const job = await this.get(clientId, processId); if (!job || !ACTIVE_PROCESS_STATUSES.includes(job.status)) return null; job.status = 'cancelled'; job.stage = 'cancelled'; job.cancelledAt = new Date(); return this.save(job); }
  async updateReview(clientId, processId, kind, value, update) { const job = await this.get(clientId, processId); if (!job || job.status !== 'review_required') return null; const item = job.result?.classifications?.[kind === 'product' ? 'products' : 'statuses']?.find((entry) => entry.value === value); if (!item) return null; Object.assign(item, update); return this.save(job); }
}
module.exports = { ReportStore, ProcessingStore, UniversalStore, UniversalOrder, UniversalOrderOccurrence, UniversalSync, aggregate, applyFilters, csv, csvLine, safeCell, universalExportRows, UNIVERSAL_EXPORT_HEADERS, dimensions };
