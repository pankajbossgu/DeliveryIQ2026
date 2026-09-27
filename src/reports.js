const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { MAX_SOURCE_ROWS, normalizeOrderId, normalizePaymentMode } = require('./upload');
const CATEGORIES = ['Delivered', 'In Transit', 'NDR', 'RTO', 'Cancelled', 'Other'];
const UNIVERSAL_SYNC_BATCH_SIZE = 2000;
function recordDuration(timings, name, startedAt) { if (timings) { const stages = timings.stages || (timings.stages = {}); stages[name] = (stages[name] || 0) + performance.now() - startedAt; } }
const rowSchema = new mongoose.Schema({ reportId: { type: String, index: true }, clientId: { type: String, index: true }, orderId: String, normalizedOrderId: String, orderDate: String, category: String, originalStatus: String, normalizedStatus: String, originalProductName: String, normalizedProductName: String, masterCategory: String, productCategory: String, paymentMode: String, courier: String, orderSource: String, quantity: Number, productPrice: Number, rowValue: Number }, { versionKey: false });
rowSchema.index({ clientId: 1, reportId: 1, orderDate: 1 });
const reportSchema = new mongoose.Schema({ reportId: { type: String, unique: true }, clientId: { type: String, index: true }, requestId: { type: String }, reportName: String, templateType: String, sourceFileName: String, sourceRowCount: Number, uniqueOrderCount: Number, reportStatus: String, createdAt: Date, completedAt: Date, summary: Object, dateRange: Object, availableDimensions: [String], analytics: Object, analyticsRef: mongoose.Schema.Types.Mixed }, { versionKey: false });
reportSchema.index({ clientId: 1, createdAt: -1 }); reportSchema.index({ clientId: 1, requestId: 1 }, { unique: true, sparse: true });
const Report = mongoose.models.Report || mongoose.model('Report', reportSchema); const ReportRow = mongoose.models.ReportRow || mongoose.model('ReportRow', rowSchema);

// UniversalOrder is the tenant-scoped latest projection; UniversalOrderOccurrence is immutable
// report evidence; UniversalSync is the idempotent completed-report synchronization ledger.
const universalLineSchema = new mongoose.Schema({ originalProductName: String, normalizedProductName: String, masterCategory: String, productCategory: String, quantity: Number, productPrice: Number, rowValue: Number }, { _id: false });
const universalOrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, canonicalOrderId: { type: String, required: true }, originalOrderId: String,
  latestReportId: { type: String, required: true }, latestReportCompletedAt: { type: Date, required: true },
  orderDate: String, originalStatus: String, normalizedStatus: String, statusCategory: String,
  paymentMode: String, courier: String, orderSource: String, products: { type: [universalLineSchema], default: [] }, productsRef: mongoose.Schema.Types.Mixed,
  totalQuantity: Number, totalValue: Number
}, { timestamps: true, versionKey: false });
universalOrderSchema.index({ clientId: 1, canonicalOrderId: 1 }, { unique: true });
universalOrderSchema.index({ clientId: 1, latestReportCompletedAt: -1 });
// These match the two date-filtered current-order analytics views. Product lines
// are aggregated only after the tenant/date match, so no multikey index is needed.
universalOrderSchema.index({ clientId: 1, orderDate: 1 });
universalOrderSchema.index({ clientId: 1, statusCategory: 1 });
universalOrderSchema.index({ clientId: 1, originalStatus: 1 });
universalOrderSchema.index({ clientId: 1, 'productsRef.generation': 1 }, { sparse: true });
const universalOccurrenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true, immutable: true }, canonicalOrderId: { type: String, required: true, immutable: true }, originalOrderId: String,
  reportId: { type: String, required: true, immutable: true }, reportCompletedAt: { type: Date, required: true, immutable: true },
  orderDate: String, originalStatus: String, normalizedStatus: String, statusCategory: String,
  paymentMode: String, courier: String, orderSource: String, products: { type: [universalLineSchema], default: [] }, productsRef: mongoose.Schema.Types.Mixed,
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
  return { clientId: report.clientId, canonicalOrderId, originalOrderId: first.orderId || first.originalOrderId, latestReportId: report.reportId, latestReportCompletedAt: report.completedAt, orderDate: first.orderDate, originalStatus: first.originalStatus, normalizedStatus: first.normalizedStatus, statusCategory: first.category, paymentMode: normalizePaymentMode(first.paymentMode), courier: first.courier, orderSource: first.orderSource, products, totalQuantity: products.reduce((total, line) => total + (line.quantity || 0), 0), totalValue: Number(products.reduce((total, line) => total + (line.rowValue || 0), 0).toFixed(2)) };
}
function groupUniversalRows(rows) { const grouped = new Map(); for (const row of rows) { const canonicalOrderId = normalizeOrderId(row.normalizedOrderId || row.orderId || row.originalOrderId); if (!canonicalOrderId) continue; const values = grouped.get(canonicalOrderId) || []; values.push(row); grouped.set(canonicalOrderId, values); } return grouped; }
function isLaterProjection(existing, candidate) { const currentTime = new Date(existing.latestReportCompletedAt).getTime(); const candidateTime = new Date(candidate.latestReportCompletedAt).getTime(); return candidateTime > currentTime || candidateTime === currentTime && String(candidate.latestReportId) > String(existing.latestReportId); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function dateRange(from, to) { const range = {}; if (from) range.$gte = from; if (to) range.$lte = to; return range; }
function universalSort(sortBy, direction, defaultField) { const field = sortBy || defaultField; const value = direction === 'asc' ? 1 : -1; return field === 'canonicalOrderId' ? { canonicalOrderId: value } : { [field]: value, canonicalOrderId: 1 }; }
function memorySort(sort) { const entries = Object.entries(sort); return (left, right) => { for (const [field, direction] of entries) { const a = left[field] instanceof Date ? left[field].getTime() : left[field]; const b = right[field] instanceof Date ? right[field].getTime() : right[field]; if (a === b) continue; if (a === undefined || a === null) return -direction; if (b === undefined || b === null) return direction; return a > b ? direction : -direction; } return 0; }; }
function matchesUniversal(item, filters) { const completed = item.latestReportCompletedAt || item.reportCompletedAt; return (!filters.search || item.canonicalOrderId.toLowerCase().startsWith(filters.search.toLowerCase())) && (!filters.status || item.originalStatus === filters.status) && (!filters.statusCategory || item.statusCategory === filters.statusCategory) && (!filters.paymentMode || normalizePaymentMode(item.paymentMode) === normalizePaymentMode(filters.paymentMode)) && (!filters.fromDate || item.orderDate >= filters.fromDate) && (!filters.toDate || item.orderDate <= filters.toDate) && (!filters.reportFromDate || new Date(completed) >= new Date(filters.reportFromDate)) && (!filters.reportToDate || new Date(completed) <= new Date(filters.reportToDate)); }
function buckets(items, field) { return Object.fromEntries(items.filter((item) => item._id).map((item) => [item._id, item.count])); }
function summaryFromBuckets(summary) { const total = summary.totals?.[0] || {}; return { totalOrders: total.totalOrders || 0, totalValue: Number((total.totalValue || 0).toFixed(2)), totalQuantity: total.totalQuantity || 0, byStatusCategory: buckets(summary.byStatusCategory || []), byStatus: buckets(summary.byStatus || []) }; }
function summaryFromOrders(orders) { const group = (field) => orders.reduce((result, order) => { if (order[field]) result[order[field]] = (result[order[field]] || 0) + 1; return result; }, {}); return { totalOrders: orders.length, totalValue: Number(orders.reduce((total, order) => total + (order.totalValue || 0), 0).toFixed(2)), totalQuantity: orders.reduce((total, order) => total + (order.totalQuantity || 0), 0), byStatusCategory: group('statusCategory'), byStatus: group('originalStatus') }; }
function universalFilter(clientId, { search, status, statusCategory, paymentMode, fromDate, toDate, reportFromDate, reportToDate } = {}) { const filter = { clientId }; paymentMode = normalizePaymentMode(paymentMode); if (search) filter.canonicalOrderId = { $regex: `^${escapeRegex(search)}`, $options: 'i' }; if (status) filter.originalStatus = status; if (statusCategory) filter.statusCategory = statusCategory; if (paymentMode) filter.paymentMode = paymentMode === 'COD' ? { $in: ['COD', 'cod', 'Cash on Delivery', 'cash on delivery'] } : paymentMode === 'Prepaid' ? { $in: ['Prepaid', 'prepaid', 'Pre Paid', 'pre paid'] } : paymentMode; if (fromDate || toDate) filter.orderDate = dateRange(fromDate, toDate); if (reportFromDate || reportToDate) filter.latestReportCompletedAt = dateRange(reportFromDate, reportToDate); return filter; }
function analyticsFromOrders(orders) { const summary = summaryFromOrders(orders); const total = summary.totalOrders; const grouped = (field) => Object.entries(summary[field] || {}).map(([name, count]) => ({ name, count, percentage: percent(count, total) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); const trendMap = new Map(); const productMap = new Map(); orders.forEach((order) => { if (order.orderDate) { const item = trendMap.get(order.orderDate) || { date: order.orderDate, count: 0, value: 0 }; item.count += 1; item.value += Number(order.totalValue || 0); trendMap.set(order.orderDate, item); } (order.products || []).forEach((line) => { const name = line.originalProductName || line.normalizedProductName || 'Unmapped product'; const item = productMap.get(name) || { name, quantity: 0, value: 0, orderIds: new Set() }; item.quantity += Number(line.quantity || 0); item.value += Number(line.rowValue || 0); item.orderIds.add(order.canonicalOrderId); productMap.set(name, item); }); }); const products = [...productMap.values()].map((item) => ({ name: item.name, quantity: item.quantity, value: Number(item.value.toFixed(2)), orderCount: item.orderIds.size })).sort((a, b) => b.quantity - a.quantity || b.value - a.value || a.name.localeCompare(b.name)).slice(0, 10); const rto = (summary.byStatusCategory.RTO || 0); return { summary: { ...summary, rtoOrders: rto, rtoPercentage: percent(rto, total), rtoValue: Number(orders.filter((order) => order.statusCategory === 'RTO').reduce((sum, order) => sum + Number(order.totalValue || 0), 0).toFixed(2)) }, statusCategories: grouped('byStatusCategory'), statuses: grouped('byStatus'), trends: [...trendMap.values()].map((item) => ({ ...item, value: Number(item.value.toFixed(2)) })).sort((a, b) => a.date.localeCompare(b.date)), products, attention: rto ? [{ type: 'RTO', count: rto, percentage: percent(rto, total), value: Number(orders.filter((order) => order.statusCategory === 'RTO').reduce((sum, order) => sum + Number(order.totalValue || 0), 0).toFixed(2)) }] : [] }; }
class UniversalStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) { this.mongoUri = mongoUri; this.connection = null; this.orders = new Map(); this.occurrences = new Map(); this.syncs = new Map(); this.payloads = new PayloadStore(() => this.database()); }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  async hydrateProducts(clientId, order) {
    if (order?.productsRef) order.products = await this.payloads.read(clientId, order.productsRef.ownerId, order.productsRef);
    return order;
  }
  key(clientId, value) { return `${clientId}\u001f${value}`; }
  // These read methods are deliberately the only public Universal API surface. Filters
  // are built by the HTTP layer from an allow-list; every database predicate starts
  // with the server-resolved clientId.
  async listOrders(clientId, { page, limit, search, status, statusCategory, paymentMode, fromDate, toDate, reportFromDate, reportToDate, sortBy, sortDirection }) {
    const filter = universalFilter(clientId, { search, status, statusCategory, paymentMode, fromDate, toDate, reportFromDate, reportToDate });
    const sort = universalSort(sortBy, sortDirection, 'latestReportCompletedAt');
    if (await this.database()) {
      const listProjection = { clientId: 0, products: 0, productsRef: 0, paymentMode: 0, courier: 0, orderSource: 0 };
      const [orders, total] = await Promise.all([UniversalOrder.find(filter, listProjection).sort(sort).skip((page - 1) * limit).limit(limit).lean(), UniversalOrder.countDocuments(filter)]);
      return { orders, total };
    }
    const orders = [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, { search, status, statusCategory, paymentMode, fromDate, toDate, reportFromDate, reportToDate })).sort(memorySort(sort));
    return { orders: orders.slice((page - 1) * limit, page * limit), total: orders.length };
  }
  async exportCurrentOrders(clientId, filters, { maxOrders = MAX_SOURCE_ROWS } = {}) {
    const filter = universalFilter(clientId, filters);
    const sort = universalSort(filters.sortBy, filters.sortDirection, 'latestReportCompletedAt');
    if (await this.database()) {
      const total = await UniversalOrder.countDocuments(filter);
      if (total > maxOrders) return { total, overLimit: true };
      const cursor = UniversalOrder.find(filter).select({ canonicalOrderId: 1, originalOrderId: 1, orderDate: 1, originalStatus: 1, statusCategory: 1, products: 1, productsRef: 1, totalQuantity: 1, totalValue: 1, latestReportId: 1, latestReportCompletedAt: 1 }).sort(sort).lean().cursor({ batchSize: 500 });
      const store = this;
      async function* hydrated() { for await (const order of cursor) yield await store.hydrateProducts(clientId, order); }
      return { total, orders: hydrated() };
    }
    const orders = [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters)).sort(memorySort(sort));
    if (orders.length > maxOrders) return { total: orders.length, overLimit: true };
    return { total: orders.length, orders };
  }
  async orderDetail(clientId, canonicalOrderId) {
    if (await this.database()) return this.hydrateProducts(clientId, await UniversalOrder.findOne({ clientId, canonicalOrderId }).lean());
    return this.orders.get(this.key(clientId, canonicalOrderId)) || null;
  }
  async orderHistory(clientId, canonicalOrderId, { page, limit, fromDate, toDate, reportFromDate, reportToDate }) {
    const filter = { clientId, canonicalOrderId };
    if (fromDate || toDate) filter.orderDate = dateRange(fromDate, toDate);
    if (reportFromDate || reportToDate) filter.reportCompletedAt = dateRange(reportFromDate, reportToDate);
    const sort = { reportCompletedAt: -1, reportId: -1 };
    if (await this.database()) {
      const [occurrences, total] = await Promise.all([UniversalOrderOccurrence.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), UniversalOrderOccurrence.countDocuments(filter)]);
      for (const occurrence of occurrences) await this.hydrateProducts(clientId, occurrence);
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
      const hasExternalProducts = Boolean(await UniversalOrder.exists({ ...filter, 'productsRef.generation': { $exists: true } }));
      const productGroups = [
        { $unwind: '$products' },
        { $group: { _id: { name: { $ifNull: ['$products.originalProductName', '$products.normalizedProductName'] }, orderId: '$canonicalOrderId' }, quantity: { $sum: { $ifNull: ['$products.quantity', 0] } }, value: { $sum: { $ifNull: ['$products.rowValue', 0] } } } },
        { $group: { _id: '$_id.name', quantity: { $sum: '$quantity' }, value: { $sum: '$value' }, orderCount: { $sum: 1 } } }
      ];
      const [result] = await UniversalOrder.aggregate([{ $match: filter }, { $facet: {
        totals: [{ $group: { _id: null, totalOrders: { $sum: 1 }, totalValue: { $sum: { $ifNull: ['$totalValue', 0] } }, totalQuantity: { $sum: { $ifNull: ['$totalQuantity', 0] } }, rtoOrders: { $sum: { $cond: [{ $eq: ['$statusCategory', 'RTO'] }, 1, 0] } }, rtoValue: { $sum: { $cond: [{ $eq: ['$statusCategory', 'RTO'] }, { $ifNull: ['$totalValue', 0] }, 0] } } } }],
        // Facets are intentionally bounded; products are reduced to the top ten after grouping.
        statusCategories: [{ $group: { _id: '$statusCategory', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
        statuses: [{ $group: { _id: '$originalStatus', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
        trends: [{ $match: { orderDate: { $type: 'string', $ne: '' } } }, { $group: { _id: '$orderDate', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$totalValue', 0] } } } }, { $sort: { _id: 1 } }],
        ...(hasExternalProducts ? {} : { products: [...productGroups, { $sort: { quantity: -1, value: -1, _id: 1 } }, { $limit: 10 }] })
      } }]);
      if (hasExternalProducts) {
        // Stream reduced inline products, then only orders with external snapshots.
        // Merge before taking ten: a lower-ranked inline product may win after merging.
        const products = new Map();
        const inline = UniversalOrder.aggregate([{ $match: { ...filter, 'productsRef.generation': { $exists: false } } }, ...productGroups]).cursor({ batchSize: 500 });
        for await (const item of inline) products.set(item._id ?? null, item);
        const external = UniversalOrder.find({ ...filter, 'productsRef.generation': { $exists: true } }).select({ productsRef: 1 }).lean().cursor({ batchSize: 1 });
        for await (const order of external) {
          await this.hydrateProducts(clientId, order);
          const seen = new Set();
          for (const line of order.products) {
            const name = line.originalProductName ?? line.normalizedProductName ?? null;
            const item = products.get(name) || { _id: name, quantity: 0, value: 0, orderCount: 0 };
            item.quantity += Number(line.quantity || 0); item.value += Number(line.rowValue || 0);
            if (!seen.has(name)) { item.orderCount += 1; seen.add(name); }
            products.set(name, item);
          }
        }
        result.products = [...products.values()].sort((a, b) => b.quantity - a.quantity || b.value - a.value || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)).slice(0, 10);
      }
      const total = result?.totals?.[0] || {}; const totalOrders = total.totalOrders || 0;
      const breakdown = (items) => (items || []).filter((item) => item._id).map((item) => ({ name: item._id, count: item.count, percentage: percent(item.count, totalOrders) }));
      const summary = { totalOrders, totalValue: Number((total.totalValue || 0).toFixed(2)), totalQuantity: total.totalQuantity || 0, byStatusCategory: buckets(result?.statusCategories || []), byStatus: buckets(result?.statuses || []), rtoOrders: total.rtoOrders || 0, rtoPercentage: percent(total.rtoOrders || 0, totalOrders), rtoValue: Number((total.rtoValue || 0).toFixed(2)) };
      return { summary, statusCategories: breakdown(result?.statusCategories), statuses: breakdown(result?.statuses), trends: (result?.trends || []).map((item) => ({ date: item._id, count: item.count, value: Number((item.value || 0).toFixed(2)) })), products: (result?.products || []).map((item) => ({ name: item._id || 'Unmapped product', quantity: item.quantity || 0, value: Number((item.value || 0).toFixed(2)), orderCount: item.orderCount || 0 })), attention: total.rtoOrders ? [{ type: 'RTO', count: total.rtoOrders, percentage: percent(total.rtoOrders, totalOrders), value: Number((total.rtoValue || 0).toFixed(2)) }] : [] };
    }
    return analyticsFromOrders([...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters)));
  }
  async groupedReport(clientId, filters = {}) {
    const analyzeBy = filters.analyzeBy || 'product';
    const deliveryView = filters.deliveryView || 'all_orders';
    if (!['all_orders', 'shipped_orders'].includes(deliveryView)) throw new Error('Invalid report basis.');
    const labels = { product: 'Product', product_category: 'Product Category', courier: 'Courier', category_status: 'Status Category' };
    if (!labels[analyzeBy]) throw new Error('Invalid Universal Report view.');
    const filter = universalFilter(clientId, filters);
    const database = await this.database();
    const orders = await (database ? UniversalOrder.find(filter).lean() : [...this.orders.values()].filter((order) => order.clientId === clientId && matchesUniversal(order, filters)));
    if (database) for (const order of orders) await this.hydrateProducts(clientId, order);
    const paymentModes = database ? await UniversalOrder.distinct('paymentMode', { clientId, paymentMode: { $type: 'string', $ne: '' } }) : [...new Set([...this.orders.values()].filter((order) => order.clientId === clientId && order.paymentMode).map((order) => order.paymentMode))];
    const emptyCounts = () => Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
    const groups = new Map();
    const add = (key, name, order, value) => {
      const item = groups.get(key) || { name, totalOrders: 0, delivered: 0, inTransit: 0, ndr: 0, rto: 0, cancelled: 0, other: 0, totalOrderValue: 0, deliveredOrderValue: 0, _orders: new Set() };
      if (!item._orders.has(order.canonicalOrderId)) {
        item._orders.add(order.canonicalOrderId); item.totalOrders += 1;
        const category = order.statusCategory && CATEGORIES.includes(order.statusCategory) ? order.statusCategory : 'Other';
        const field = { Delivered: 'delivered', 'In Transit': 'inTransit', NDR: 'ndr', RTO: 'rto', Cancelled: 'cancelled', Other: 'other' }[category]; item[field] += 1;
      }
      item.totalOrderValue += Number(value || 0);
      if (order.statusCategory === 'Delivered') item.deliveredOrderValue += Number(value || 0);
      groups.set(key, item);
    };
    for (const order of orders) {
      if (analyzeBy === 'product' || analyzeBy === 'product_category') {
        for (const line of order.products || []) {
          const raw = analyzeBy === 'product' ? (line.normalizedProductName || line.originalProductName) : line.productCategory;
          const display = analyzeBy === 'product' ? (line.originalProductName || line.normalizedProductName) : line.productCategory;
          const name = String(display || 'Unmapped').trim() || 'Unmapped'; const key = String(raw || 'unmapped').trim().toLowerCase() || 'unmapped';
          add(key, name, order, line.rowValue);
        }
      } else if (analyzeBy === 'courier') {
        const name = String(order.courier || 'Unmapped courier').trim() || 'Unmapped courier'; add(name.toLowerCase(), name, order, order.totalValue);
      } else {
        const name = CATEGORIES.includes(order.statusCategory) ? order.statusCategory : 'Other'; add(name, name, order, order.totalValue);
      }
    }
    if (analyzeBy === 'category_status') for (const category of CATEGORIES) if (!groups.has(category)) groups.set(category, { name: category, totalOrders: 0, delivered: 0, inTransit: 0, ndr: 0, rto: 0, cancelled: 0, other: 0, totalOrderValue: 0, deliveredOrderValue: 0, _orders: new Set() });
    const shippedBasis = deliveryView === 'shipped_orders';
    const orderTotalLabel = shippedBasis ? 'Shipped Orders' : 'Total Orders';
    // Apply the same basis to a group and the report summary; counts stay intact.
    const basisMetrics = (totalOrders, counts) => {
      const shippedOrders = counts.Delivered + counts['In Transit'] + counts.NDR + counts.RTO;
      const orderTotal = shippedBasis ? shippedOrders : totalOrders;
      const percentages = Object.fromEntries(CATEGORIES.map((category) => [category,
        shippedBasis && !['Delivered', 'In Transit', 'NDR', 'RTO'].includes(category) ? null : percent(counts[category], orderTotal)
      ]));
      return { shippedOrders, orderTotal, orderTotalLabel, percentages, deliveryPercentage: percentages.Delivered };
    };
    const rows = [...groups.values()].map(({ _orders, ...row }) => ({
      ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(2)) : value])),
      ...basisMetrics(row.totalOrders, { Delivered: row.delivered, 'In Transit': row.inTransit, NDR: row.ndr, RTO: row.rto, Cancelled: row.cancelled, Other: row.other })
    })).sort((a, b) => b.totalOrders - a.totalOrders || a.name.localeCompare(b.name));
    const totals = summaryFromOrders(orders);
    totals.deliveredOrders = totals.byStatusCategory.Delivered || 0; totals.inTransitOrders = totals.byStatusCategory['In Transit'] || 0; totals.ndrOrders = totals.byStatusCategory.NDR || 0; totals.rtoOrders = totals.byStatusCategory.RTO || 0; totals.cancelledOrders = totals.byStatusCategory.Cancelled || 0; totals.otherOrders = totals.byStatusCategory.Other || 0;
    totals.deliveredOrderValue = Number(orders.filter((order) => order.statusCategory === 'Delivered').reduce((sum, order) => sum + Number(order.totalValue || 0), 0).toFixed(2));
    totals.deliveryView = deliveryView;
    Object.assign(totals, basisMetrics(totals.totalOrders, { ...emptyCounts(), ...totals.byStatusCategory }));
    const dates = orders.map((order) => order.orderDate).filter(Boolean).sort();
    return { analyzeBy, deliveryView, orderTotalLabel, groupLabel: labels[analyzeBy], rows, totals, paymentModes: paymentModes.sort((a, b) => String(a).localeCompare(String(b))), range: { from: dates[0] || null, to: dates.at(-1) || null } };
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
  async syncCompletedReport(clientId, report, rows, performanceTimings) {
    if (!report || report.clientId !== clientId || report.reportStatus !== 'completed' || !report.completedAt) return { status: 'skipped' };
    console.info(JSON.stringify({ event: 'universal_sync_started', clientId, reportId: report.reportId, sourceRows: rows.length }));
    const syncKey = this.key(clientId, report.reportId); const emptyCounts = { ordersProcessed: 0, occurrencesCreated: 0, ordersInserted: 0, ordersUpdated: 0, skippedDuplicateObservations: 0 };
    if (await this.database()) return this.syncMongo(clientId, report, rows, emptyCounts, performanceTimings);
    const prior = this.syncs.get(syncKey); if (prior?.status === 'completed') return { ...prior, alreadyCompleted: true };
    const sync = { clientId, reportId: report.reportId, status: 'processing', startedAt: new Date(), completedAt: null, error: null, counts: { ...emptyCounts } }; this.syncs.set(syncKey, sync);
    try { const groups = groupUniversalRows(rows); sync.counts.ordersProcessed = groups.size;
      for (const [canonicalOrderId, orderRows] of groups) { const occurrenceKey = this.key(clientId, `${report.reportId}\u001f${canonicalOrderId}`); if (this.occurrences.has(occurrenceKey)) { sync.counts.skippedDuplicateObservations += 1; continue; }
        const projection = universalProjection(report, canonicalOrderId, orderRows); this.occurrences.set(occurrenceKey, { ...projection, reportId: report.reportId, reportCompletedAt: report.completedAt, sourceFileName: report.sourceFileName, templateType: report.templateType }); sync.counts.occurrencesCreated += 1;
        const orderKey = this.key(clientId, canonicalOrderId); const existing = this.orders.get(orderKey); if (!existing) { this.orders.set(orderKey, projection); sync.counts.ordersInserted += 1; } else if (isLaterProjection(existing, projection)) { this.orders.set(orderKey, projection); sync.counts.ordersUpdated += 1; }
      } sync.status = 'completed'; sync.completedAt = new Date(); console.info(JSON.stringify({ event: 'universal_sync_completed', clientId, reportId: report.reportId, counts: sync.counts })); return sync;
    } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); return this.markFailed(clientId, report.reportId); }
  }
  async syncMongo(clientId, report, rows, emptyCounts, performanceTimings) {
    const existing = await UniversalSync.findOne({ clientId, reportId: report.reportId }).lean(); if (existing?.status === 'completed') return { ...existing, alreadyCompleted: true };
    await UniversalSync.updateOne({ clientId, reportId: report.reportId }, { $set: { status: 'processing', startedAt: new Date(), completedAt: null, error: null }, $setOnInsert: { clientId, reportId: report.reportId, counts: emptyCounts } }, { upsert: true });
    try { const groups = groupUniversalRows(rows); const projections = [...groups.entries()].map(([id, orderRows]) => universalProjection(report, id, orderRows));
      // An order may contain every source line. Its product array must not become
      // another dataset-sized BSON document after process storage is chunked.
      for (const projection of projections) {
        if (mongoose.mongo.BSON.calculateObjectSize(projection) < 8 * 1024 * 1024) continue;
        const ownerId = crypto.createHash('sha256').update(`${report.reportId}\u001f${projection.canonicalOrderId}`).digest('hex');
        const existingOccurrence = await UniversalOrderOccurrence.findOne({ clientId, reportId: report.reportId, canonicalOrderId: projection.canonicalOrderId }).select({ productsRef: 1 }).lean();
        projection.productsRef = existingOccurrence?.productsRef || { ...await this.payloads.write(clientId, ownerId, projection.products, { reuse: true }), ownerId };
        projection.products = [];
      }
      let occurrencesCreated = 0; let ordersInserted = 0; let ordersUpdated = 0;
      for (let offset = 0; offset < projections.length; offset += UNIVERSAL_SYNC_BATCH_SIZE) {
        const batch = projections.slice(offset, offset + UNIVERSAL_SYNC_BATCH_SIZE);
        let bulkWriteStartedAt = performance.now();
        const occurrenceResult = await UniversalOrderOccurrence.bulkWrite(batch.map((projection) => ({ updateOne: { filter: { clientId, reportId: report.reportId, canonicalOrderId: projection.canonicalOrderId }, update: { $setOnInsert: { ...projection, reportId: report.reportId, reportCompletedAt: report.completedAt, sourceFileName: report.sourceFileName, templateType: report.templateType } }, upsert: true } })), { ordered: false });
        recordDuration(performanceTimings, 'mongoOccurrenceBulkWriteMs', bulkWriteStartedAt);
        bulkWriteStartedAt = performance.now();
        const insertResult = await UniversalOrder.bulkWrite(batch.map((projection) => ({ updateOne: { filter: { clientId, canonicalOrderId: projection.canonicalOrderId }, update: { $setOnInsert: projection }, upsert: true } })), { ordered: false });
        recordDuration(performanceTimings, 'mongoOrderInsertBulkWriteMs', bulkWriteStartedAt);
        // Completion time, then report ID, remain the sole projection ordering keys.
        bulkWriteStartedAt = performance.now();
        const updateResult = await UniversalOrder.bulkWrite(batch.map((projection) => ({ updateOne: { filter: { clientId, canonicalOrderId: projection.canonicalOrderId, $or: [{ latestReportCompletedAt: { $lt: report.completedAt } }, { latestReportCompletedAt: report.completedAt, latestReportId: { $lt: report.reportId } }] }, update: { $set: projection, ...(!projection.productsRef ? { $unset: { productsRef: 1 } } : {}) } } })), { ordered: false });
        recordDuration(performanceTimings, 'mongoOrderUpdateBulkWriteMs', bulkWriteStartedAt);
        occurrencesCreated += occurrenceResult.upsertedCount || 0; ordersInserted += insertResult.upsertedCount || 0; ordersUpdated += updateResult.modifiedCount || 0;
      }
      const counts = { ordersProcessed: projections.length, occurrencesCreated, ordersInserted, ordersUpdated, skippedDuplicateObservations: projections.length - occurrencesCreated };
      const completed = await UniversalSync.findOneAndUpdate({ clientId, reportId: report.reportId }, { $set: { status: 'completed', completedAt: new Date(), error: null, counts } }, { new: true }).lean();
      console.info(JSON.stringify({ event: 'universal_sync_completed', clientId, reportId: report.reportId, counts })); return completed;
    } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); return this.markFailed(clientId, report.reportId); }
  }
}
function persistedReportRows(clientId, reportId, rows) {
  return rows.map((row) => ({ reportId, clientId, orderId: row.originalOrderId || row.orderId || row.order_id, normalizedOrderId: row.normalizedOrderId || row.orderId || row.order_id, orderDate: row.orderDate || row.order_date, category: row.category, originalStatus: row.originalStatus, normalizedStatus: row.normalizedStatus, originalProductName: row.originalProductName, normalizedProductName: row.normalizedProductName, masterCategory: row.masterCategory, productCategory: row.productCategory, paymentMode: row.paymentMode || row.payment_mode, courier: row.courier, orderSource: row.orderSource || row.order_source, quantity: row.quantity, productPrice: row.productPrice, rowValue: row.rowValue }));
}
class ReportStore {
  constructor({ mongoUri = process.env.MONGODB_URI, universalStore } = {}) { this.mongoUri = mongoUri; this.connection = null; this.memory = new Map(); this.rows = new Map(); this.universalStore = universalStore || new UniversalStore({ mongoUri }); this.payloads = new PayloadStore(() => this.database()); }
  async synchronizeUniversal(clientId, report, rows, performanceTimings) { try { return await this.universalStore.syncCompletedReport(clientId, report, rows, performanceTimings); } catch (error) { console.warn(JSON.stringify({ event: 'universal_sync_failed', clientId, reportId: report.reportId, message: error?.message || 'unknown' })); if (typeof this.universalStore.markFailed === 'function') { try { return await this.universalStore.markFailed(clientId, report.reportId); } catch { /* The completed report remains authoritative if storage is unavailable. */ } } return { status: 'failed' }; } }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  async retryUniversal(clientId, reportId) {
    const database = await this.database(); const report = database ? await Report.findOne({ clientId, reportId, reportStatus: 'completed' }).lean() : this.memory.get(reportId);
    if (!report || report.clientId !== clientId || report.reportStatus !== 'completed') return { status: 'skipped' };
    const rows = database ? await ReportRow.find({ clientId, reportId }).lean() : this.rows.get(reportId) || [];
    console.info(JSON.stringify({ event: 'universal_sync_retry_started', clientId, reportId, orders: groupUniversalRows(rows).size }));
    return this.synchronizeUniversal(clientId, report, rows);
  }
  async create(clientId, input, performanceTimings = input.rows.__performance) {
    const database = await this.database();
    if (input.requestId) {
      const existing = database ? await Report.findOne({ clientId, requestId: input.requestId }).lean() : [...this.memory.values()].find((item) => item.clientId === clientId && item.requestId === input.requestId);
      if (existing) return existing;
    }
    const reportRowsStartedAt = performance.now();
    const reportId = crypto.randomUUID(); const calculated = aggregate(input.rows, input.templateType);
    let firstDate = null; let lastDate = null;
    for (const row of input.rows) { const date = row.orderDate || row.order_date; if (date && (!firstDate || date < firstDate)) firstDate = date; if (date && (!lastDate || date > lastDate)) lastDate = date; }
    const dates = [firstDate, lastDate];
    const report = { reportId, clientId, requestId: input.requestId, reportName: input.reportName || `Delivery Report — ${dates[0] === dates.at(-1) ? dates[0] : `${dates[0]}–${dates.at(-1)}`}`, templateType: input.templateType, sourceFileName: input.sourceFileName, sourceRowCount: input.rows.length, uniqueOrderCount: calculated.totalOrders, reportStatus: 'processing', createdAt: new Date(), completedAt: null, summary: calculated.summary, dateRange: { from: dates[0] || null, to: dates.at(-1) || null }, availableDimensions: dimensions(input.templateType), analytics: calculated.analytics };
    const persistedRows = persistedReportRows(clientId, reportId, input.rows);
    // Analytics can also be large when every source row has a different product.
    report.analyticsRef = await this.payloads.write(clientId, reportId, report.analytics);
    const storedReport = { ...report, analytics: { statusDistribution: report.analytics.statusDistribution } };
    try {
      if (database) { await Report.create(storedReport); for (let offset = 0; offset < persistedRows.length; offset += 500) await ReportRow.insertMany(persistedRows.slice(offset, offset + 500)); report.reportStatus = 'completed'; report.completedAt = new Date(); await Report.updateOne({ clientId, reportId }, { $set: { reportStatus: report.reportStatus, completedAt: report.completedAt } }); }
      else { this.memory.set(reportId, storedReport); this.rows.set(reportId, persistedRows); report.reportStatus = 'completed'; report.completedAt = new Date(); Object.assign(storedReport, { reportStatus: report.reportStatus, completedAt: report.completedAt }); }
    } catch (error) {
      // A lost acknowledgement may follow a successful metadata write. Only
      // clean up definite rejections, and never remove a referenced snapshot.
      if (!database || error?.code === 11000 || error?.name === 'ValidationError') {
        try {
          const referenced = database
            ? await Report.exists({ clientId, reportId, 'analyticsRef.generation': report.analyticsRef.generation }).read('primary')
            : this.memory.get(reportId)?.analyticsRef?.generation === report.analyticsRef.generation;
          if (!referenced) await this.payloads.discard(clientId, reportId, report.analyticsRef);
        } catch { /* Preserve the original error and retain chunks if cleanup is uncertain. */ }
      }
      throw error;
    }
    recordDuration(performanceTimings, 'reportRowGenerationMs', reportRowsStartedAt);
    console.info(JSON.stringify({ event: 'report_completed', clientId, reportId, orders: calculated.totalOrders }));
    const universalSyncStartedAt = performance.now();
    await this.synchronizeUniversal(clientId, report, persistedRows, performanceTimings);
    recordDuration(performanceTimings, 'universalSyncMs', universalSyncStartedAt);
    if (performanceTimings) {
      const stages = performanceTimings.stages || {};
      stages.mongoBulkWriteMs = (stages.mongoOccurrenceBulkWriteMs || 0) + (stages.mongoOrderInsertBulkWriteMs || 0) + (stages.mongoOrderUpdateBulkWriteMs || 0);
      const totalReportGenerationMs = performanceTimings.startedAtEpochMs ? performance.timeOrigin + performance.now() - performanceTimings.startedAtEpochMs : null;
      console.info(JSON.stringify({ event: 'report_generation_performance', clientId, reportId, orders: calculated.totalOrders, timingsMs: { fileParsingExtraction: stages.fileParsingExtractionMs || 0, rowNormalization: stages.rowNormalizationMs || 0, productExtractionClassification: stages.productExtractionClassificationMs || 0, statusMapping: stages.statusMappingMs || 0, reportRowGeneration: stages.reportRowGenerationMs || 0, universalReportSync: stages.universalSyncMs || 0, mongoBulkWrites: stages.mongoBulkWriteMs, mongoOccurrenceBulkWrites: stages.mongoOccurrenceBulkWriteMs || 0, mongoOrderInsertBulkWrites: stages.mongoOrderInsertBulkWriteMs || 0, mongoOrderUpdateBulkWrites: stages.mongoOrderUpdateBulkWriteMs || 0, totalReportGeneration: totalReportGenerationMs } }));
    }
    return report;
  }
  async list(clientId) { if (await this.database()) return Report.find({ clientId, reportStatus: 'completed' }).sort({ createdAt: -1 }).lean(); return [...this.memory.values()].filter((report) => report.clientId === clientId && report.reportStatus === 'completed').sort((a, b) => b.createdAt - a.createdAt); }
  async detail(clientId, reportId, filters = {}) { const report = await (await this.database() ? Report.findOne({ clientId, reportId }).lean() : this.memory.get(reportId)); if (!report || report.clientId !== clientId) return null; const analytics = report.analyticsRef ? await this.payloads.read(clientId, reportId, report.analyticsRef) : report.analytics; const allRows = await (await this.database() ? ReportRow.find({ clientId, reportId }).lean() : this.rows.get(reportId) || []); const rows = applyFilters(allRows, filters, report.templateType); return { ...report, analytics, filtered: aggregate(rows, report.templateType), filters: { availableDimensions: report.availableDimensions }, exportRows: rows }; }
}
// A failed process is still unfinished: only completion or explicit removal releases the client.
const ACTIVE_PROCESS_STATUSES = ['queued', 'processing', 'review_required', 'finalizing', 'failed'];
const processSchema = new mongoose.Schema({
  processId: { type: String, unique: true, index: true }, clientId: { type: String, index: true }, requestId: String,
  status: { type: String, index: true }, stage: String, input: mongoose.Schema.Types.Mixed,
  result: mongoose.Schema.Types.Mixed, report: mongoose.Schema.Types.Mixed, error: String,
  createdAt: Date, updatedAt: Date, cancelledAt: Date
}, { versionKey: false, strict: false });
// The partial unique index is the server-side backstop for two concurrent browser tabs.
// Keep this separately named from the original index. Existing deployments may
// still have the earlier index, which did not include failed (and therefore
// still unfinished) processes in its partial filter.
processSchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ACTIVE_PROCESS_STATUSES } }, name: 'one_active_unfinished_report_process_per_client_v2' });
const ReportProcess = mongoose.models.ReportProcess || mongoose.model('ReportProcess', processSchema, 'reportProcesses');
// Large snapshots are immutable byte chunks; only their references live on the process.
// Two MiB leaves ample BSON headroom, including for unusually long individual rows.
const PAYLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const payloadSchema = new mongoose.Schema({ clientId: String, ownerId: String, generation: String, index: Number, data: Buffer, expiresAt: Date }, { versionKey: false });
payloadSchema.index({ clientId: 1, ownerId: 1, generation: 1, index: 1 }, { unique: true });
payloadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const ReportPayload = mongoose.models.ReportPayload || mongoose.model('ReportPayload', payloadSchema, 'reportPayloads');
class PayloadStore {
  constructor(database) { this.database = database; this.memory = new Map(); }
  async write(clientId, ownerId, value, { reuse = false } = {}) {
    for (const [key, item] of this.memory) if (item.expiresAt && item.expiresAt <= new Date()) this.memory.delete(key);
    function* pieces() {
      if (!Array.isArray(value)) { yield JSON.stringify(value); return; }
      yield '[';
      for (let i = 0; i < value.length; i += 1) { yield (i ? ',' : '') + JSON.stringify(value[i]); }
      yield ']';
    }
    let generation = crypto.randomUUID();
    if (reuse) {
      const hash = crypto.createHash('sha256').update(JSON.stringify([clientId, ownerId]));
      for (const text of pieces()) hash.update(text);
      generation = hash.digest('hex');
    }
    let count = 0; let used = 0; let buffer = Buffer.allocUnsafe(PAYLOAD_CHUNK_BYTES);
    const database = await this.database();
    const flush = async () => {
      if (!used) return;
      const record = { clientId, ownerId, generation, index: count++, data: Buffer.from(buffer.subarray(0, used)) };
      if (database) {
        if (reuse) {
          const filter = { clientId, ownerId, generation, index: record.index };
          try { await ReportPayload.updateOne(filter, { $setOnInsert: record }, { upsert: true }); }
          catch (error) {
            if (error?.code !== 11000) throw error;
            // Another retry can insert this identical immutable chunk first.
            await ReportPayload.updateOne(filter, { $setOnInsert: record }, { upsert: true });
          }
        } else await ReportPayload.create(record);
      } else this.memory.set(JSON.stringify([clientId, ownerId, generation, record.index]), record);
      used = 0;
    };
    try {
      for (const text of pieces()) {
        const bytes = Buffer.from(text);
        for (let offset = 0; offset < bytes.length;) {
          const length = Math.min(buffer.length - used, bytes.length - offset);
          bytes.copy(buffer, used, offset, offset + length); used += length; offset += length;
          if (used === buffer.length) await flush();
        }
      }
      await flush();
      return { generation, count };
    } catch (error) {
      // Shared retry generations may already be referenced by another writer.
      // Retain partial chunks so the next identical retry can finish them.
      if (!reuse) await this.discard(clientId, ownerId, { generation }).catch(() => {});
      throw error;
    }
  }
  async read(clientId, ownerId, reference) {
    const filter = { clientId, ownerId, generation: reference.generation };
    const records = await this.database()
      ? await ReportPayload.find(filter).sort({ index: 1 }).lean()
      : [...this.memory.values()].filter((item) => item.clientId === clientId && item.ownerId === ownerId && item.generation === reference.generation).sort((a, b) => a.index - b.index);
    if (records.length !== reference.count || records.some((item, index) => item.index !== index)) throw new Error('Incomplete report payload');
    return JSON.parse(Buffer.concat(records.map((item) => Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data.buffer))).toString('utf8'));
  }
  async discard(clientId, ownerId, reference, delayed = false) {
    if (!reference) return;
    const filter = { clientId, ownerId, generation: reference.generation };
    if (await this.database()) {
      // Give readers holding the previous reference time to finish before TTL cleanup.
      if (delayed) await ReportPayload.updateMany(filter, { $set: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
      else await ReportPayload.deleteMany(filter);
    } else for (const [key, item] of this.memory) if (item.clientId === clientId && item.ownerId === ownerId && item.generation === reference.generation) { if (delayed) item.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); else this.memory.delete(key); }
  }
}
class ProcessingStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) {
    this.mongoUri = mongoUri; this.connection = null; this.jobs = new Map();
    this.payloads = new PayloadStore(() => this.database());
  }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 5000 }); return this.connection; }
  public(job) {
    if (!job) return null;
    const { input, result, payloads, revision, _id, ...details } = job;
    return { ...details, summary: input.summary, templateType: input.templateType, file: input.file, classifications: result?.classifications || null };
  }
  async hydrate(record, { includeRows = true, metadataOnly = false } = {}) {
    if (!record) return null;
    const job = structuredClone(record); delete job._id;
    if (metadataOnly) return job;
    const refs = job.payloads || {};
    if (includeRows && refs.rows) job.input.normalizedRows = await this.payloads.read(job.clientId, job.processId, refs.rows);
    if (job.result?.classifications) {
      for (const key of ['statuses', 'products']) if (refs[key]) job.result.classifications[key] = await this.payloads.read(job.clientId, job.processId, refs[key]);
    }
    return job;
  }
  async getActiveProcess(clientId, options = {}) {
    const record = await this.database()
      ? await ReportProcess.findOne({ clientId, status: { $in: ACTIVE_PROCESS_STATUSES } }).sort({ updatedAt: -1 }).lean()
      : [...this.jobs.values()].find((job) => job.clientId === clientId && ACTIVE_PROCESS_STATUSES.includes(job.status));
    return this.hydrate(record, options);
  }
  async get(clientId, processId, options = {}) {
    const record = await this.database() ? await ReportProcess.findOne({ clientId, processId }).lean() : this.jobs.get(processId);
    return record?.clientId === clientId ? this.hydrate(record, options) : null;
  }
  async createValidated(clientId, input, requestId) {
    const active = await this.getActiveProcess(clientId, { includeRows: false }); if (active) return { job: active, existing: true };
    const processId = crypto.randomUUID();
    const rows = await this.payloads.write(clientId, processId, input.normalizedRows);
    const { normalizedRows, ...metadata } = input;
    const job = { processId, clientId, requestId: requestId || crypto.randomUUID(), revision: crypto.randomUUID(), status: 'queued', stage: 'validated', createdAt: new Date(), updatedAt: new Date(), input: metadata, payloads: { rows }, result: null, report: null, error: null };
    try {
      if (await this.database()) await ReportProcess.create(job);
      else { const current = await this.getActiveProcess(clientId, { includeRows: false }); if (current) { await this.payloads.discard(clientId, processId, rows); return { job: current, existing: true }; } this.jobs.set(processId, structuredClone(job)); }
    } catch (error) {
      if (error?.code === 11000) {
        await this.payloads.discard(clientId, processId, rows);
        return { job: await this.getActiveProcess(clientId, { includeRows: false }), existing: true };
      }
      // An acknowledgement can be lost after MongoDB committed the reference.
      // Retain chunks on ambiguous publication errors; maintenance can reclaim orphans.
      throw error;
    }
    return { job: { ...job, input }, existing: false };
  }
  async publish(job, patch, { review = false } = {}) {
    const filter = { clientId: job.clientId, processId: job.processId, ...(review ? { status: 'review_required' } : { status: { $ne: 'cancelled' } }), ...(job.revision ? { revision: job.revision } : { updatedAt: job.updatedAt }) };
    const next = { ...patch, revision: crypto.randomUUID(), updatedAt: new Date() };
    let saved;
    if (await this.database()) saved = await ReportProcess.findOneAndUpdate(filter, { $set: next }, { new: true }).lean();
    else {
      const current = this.jobs.get(job.processId);
      if (current?.clientId === job.clientId && current.status !== 'cancelled' && (!review || current.status === 'review_required') && current.revision === job.revision) {
        saved = { ...current, ...structuredClone(next) }; this.jobs.set(job.processId, saved);
      }
    }
    if (saved) { job.revision = saved.revision; job.updatedAt = saved.updatedAt; }
    return saved;
  }
  async save(job, { metadataOnly = false } = {}) {
    const patch = { status: job.status, stage: job.stage, error: job.error, ...(job.cancelledAt ? { cancelledAt: job.cancelledAt } : {}) };
    const added = []; const replaced = []; let publishing = false;
    try {
      if (!metadataOnly) {
        patch.payloads = { ...job.payloads };
        // Migrate legacy inline inputs when they are next saved.
        if (!patch.payloads.rows && job.input?.normalizedRows) {
          patch.payloads.rows = await this.payloads.write(job.clientId, job.processId, job.input.normalizedRows); added.push(patch.payloads.rows);
          const { normalizedRows, ...input } = job.input; patch.input = input;
        }
        if (job.result) {
          const { normalizedRows, classifications, ...result } = job.result;
          patch.result = { ...result, classifications: { ...classifications } };
          for (const key of ['statuses', 'products']) if (Array.isArray(classifications?.[key])) {
            const ref = await this.payloads.write(job.clientId, job.processId, classifications[key]);
            added.push(ref); replaced.push(patch.payloads[key]); patch.payloads[key] = ref;
            delete patch.result.classifications[key];
          }
        }
        if (job.report) { const { analytics, ...report } = job.report; patch.report = report; }
      }
      publishing = true;
      const saved = await this.publish(job, patch);
      if (!saved) { for (const ref of added) await this.payloads.discard(job.clientId, job.processId, ref); return this.get(job.clientId, job.processId, { includeRows: false }); }
      job.payloads = saved.payloads;
      for (const ref of replaced) await this.payloads.discard(job.clientId, job.processId, ref, true).catch(() => {});
      return job;
    } catch (error) {
      if (!publishing) for (const ref of added) await this.payloads.discard(job.clientId, job.processId, ref).catch(() => {});
      throw error;
    }
  }
  async start(clientId, processId, execute, { alreadyStarted = false } = {}) {
    const job = await this.get(clientId, processId); if (!job) return null;
    if (!alreadyStarted && !['queued', 'failed'].includes(job.status)) return job;
    if (!alreadyStarted) { job.status = 'processing'; job.stage = 'preparing_data'; job.error = null; const claimed = await this.save(job, { metadataOnly: true }); if (claimed !== job) return claimed; }
    const cancelled = async () => (await this.get(clientId, processId, { metadataOnly: true }))?.status === 'cancelled';
    const stage = async (value) => {
      job.stage = value;
      const saved = await this.save(job, { metadataOnly: true });
      return saved?.status !== 'cancelled';
    };
    try {
      if (!await stage('processing_orders')) return this.get(clientId, processId, { includeRows: false });
      const outcome = await execute(job, stage, cancelled);
      if (await cancelled() || outcome?.cancelled) return this.get(clientId, processId, { includeRows: false });
      job.result = outcome.result || outcome;
      if (outcome.report) return this.complete(job, outcome.report);
      const unresolved = [...job.result.classifications.statuses, ...job.result.classifications.products].some((item) => item.classificationRequired);
      job.status = unresolved ? 'review_required' : 'finalizing'; job.stage = unresolved ? 'preparing_review' : 'finalizing_report';
      return this.save(job);
    } catch (error) {
      if (await cancelled()) return this.get(clientId, processId, { includeRows: false });
      job.status = 'failed'; job.stage = 'failed'; job.error = 'Report generation could not be completed.';
      await this.save(job, { metadataOnly: true });
      console.warn(JSON.stringify({ event: 'report_processing_failed', processId, message: error?.message || 'unknown' })); return job;
    }
  }
  async complete(job, report) {
    const latest = await this.get(job.clientId, job.processId, { metadataOnly: true });
    if (!latest || latest.status === 'cancelled') return latest;
    job.status = 'completed'; job.stage = 'completed'; job.report = report;
    return this.save(job);
  }
  async cancel(clientId, processId) {
    const job = await this.get(clientId, processId, { metadataOnly: true });
    if (!job || !ACTIVE_PROCESS_STATUSES.includes(job.status)) return null;
    job.status = 'cancelled'; job.stage = 'cancelled'; job.cancelledAt = new Date();
    // Cancellation wins even when a stage changed between the read and write.
    if (await this.database()) {
      const saved = await ReportProcess.findOneAndUpdate({ clientId, processId, status: { $in: ACTIVE_PROCESS_STATUSES } }, { $set: { status: job.status, stage: job.stage, cancelledAt: job.cancelledAt, updatedAt: new Date(), revision: crypto.randomUUID() } }, { new: true }).lean();
      return this.hydrate(saved, { includeRows: false });
    }
    const current = this.jobs.get(processId);
    if (current?.clientId !== clientId || !ACTIVE_PROCESS_STATUSES.includes(current.status)) return null;
    const saved = { ...current, status: 'cancelled', stage: 'cancelled', cancelledAt: job.cancelledAt, updatedAt: new Date(), revision: crypto.randomUUID() };
    this.jobs.set(processId, saved);
    return this.hydrate(saved, { includeRows: false });
  }
  // Product reclassification stays within the existing review process. A short
  // persisted lease serializes retries across tabs/instances and expires if the
  // request is interrupted; it does not change report/status processing.
  async claimProductRetry(clientId, processId, value) {
    const job = await this.get(clientId, processId, { includeRows: false });
    if (job?.status !== 'review_required' || new Date(job.productRetry?.expiresAt || 0) > new Date()) return null;
    const productRetry = { value, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 120000) };
    return await this.publish(job, { productRetry }, { review: true }) ? productRetry : null;
  }
  async releaseProductRetry(clientId, processId, token) {
    const job = await this.get(clientId, processId, { includeRows: false });
    if (job?.productRetry?.token === token) await this.publish(job, { productRetry: null }, { review: true });
  }
  async updateReview(clientId, processId, kind, value, update) { return this.updateReviews(clientId, processId, kind, [{ ...update, value }]); }
  async updateReviews(clientId, processId, kind, updates) {
    const key = kind === 'product' ? 'products' : 'statuses';
    const job = await this.get(clientId, processId, { includeRows: false });
    if (!job || job.status !== 'review_required') return null;
    const items = job.result?.classifications?.[key]; if (!Array.isArray(items)) return null;
    const byValue = new Map(items.map((item) => [item.value, item]));
    if (updates.some((update) => !byValue.has(update.value))) return null;
    updates.forEach((update) => Object.assign(byValue.get(update.value), update));
    const reference = await this.payloads.write(clientId, processId, items);
    const previous = job.payloads?.[key];
    const { normalizedRows, classifications, ...result } = job.result;
    const nextClassifications = { ...classifications }; delete nextClassifications[key];
    // Other review arrays already live in immutable chunks; omit their hydrated copies.
    for (const other of ['statuses', 'products']) if (job.payloads?.[other]) delete nextClassifications[other];
    try {
      const saved = await this.publish(job, { payloads: { ...job.payloads, [key]: reference }, result: { ...result, classifications: nextClassifications } }, { review: true });
      if (!saved) { await this.payloads.discard(clientId, processId, reference); return null; }
      job.payloads = saved.payloads;
      await this.payloads.discard(clientId, processId, previous, true).catch(() => {});
      return job;
    } catch (error) {
      // Do not delete a generation whose reference may have committed despite a lost acknowledgement.
      throw error;
    }
  }
}

module.exports = { PayloadStore, ReportPayload, ReportProcess, PAYLOAD_CHUNK_BYTES, ReportStore, ProcessingStore, UniversalStore, UniversalOrder, UniversalOrderOccurrence, UniversalSync, aggregate, applyFilters, csv, csvLine, safeCell, universalExportRows, UNIVERSAL_EXPORT_HEADERS, dimensions };
