const crypto = require('node:crypto');
const { Report, ReportRow, ReportPayload, ReportProcess, UniversalOrder, UniversalOrderOccurrence, UniversalSync } = require('./reports');
const { ProductMapping, ProductClassificationSuggestion } = require('./mappings');

const FILTERS = {
  reports: new Set(['sourceFileName', 'fromDate', 'toDate', 'statusCategory', 'masterCategory', 'productCategory']),
  'product-mappings': new Set(['productSearch', 'source', 'masterCategory', 'productCategory']),
  'ai-suggestions': new Set(['productSearch', 'status', 'masterCategory', 'productCategory'])
};
function failure(message, code = 'INVALID_DATA_FILTERS', status = 422) { return Object.assign(new Error(message), { code, status }); }
function fingerprint(values) { return crypto.createHash('sha256').update([...values].map(String).sort().join('\n')).digest('hex'); }
function stalePreview() { return failure('The matching data changed after preview. Preview again before deleting.', 'PREVIEW_STALE', 409); }
function cleanFilters(scope, input = {}) {
  const allowed = FILTERS[scope];
  if (!allowed) throw failure('Choose a supported data type.', 'INVALID_DATA_SCOPE');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) throw failure('One or more filters are not supported for this data type.');
  const filters = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 120 || !raw.trim()) throw failure('Filter values must be text up to 120 characters.');
    filters[key] = raw.trim();
  }
  for (const key of ['fromDate', 'toDate']) {
    const value = filters[key];
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure(key + ' must use YYYY-MM-DD.');
    const date = new Date(value + 'T00:00:00.000Z');
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw failure(key + ' must be a valid date.');
  }
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) throw failure('Start date must be on or before end date.');
  return filters;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/{/g, '\\{').replace(/}/g, '\\}'); }
function dateQuery(filters) {
  const createdAt = {};
  if (filters.fromDate) createdAt.$gte = new Date(filters.fromDate + 'T00:00:00.000Z');
  if (filters.toDate) createdAt.$lte = new Date(filters.toDate + 'T23:59:59.999Z');
  return Object.keys(createdAt).length ? { createdAt } : {};
}
function reportRowQuery(clientId, filters) {
  const query = { clientId };
  if (filters.statusCategory) query.category = filters.statusCategory;
  if (filters.masterCategory) query.masterCategory = filters.masterCategory;
  if (filters.productCategory) query.productCategory = filters.productCategory;
  return query;
}
function reportQuery(clientId, filters, reportIds) {
  const query = { clientId, reportStatus: 'completed', ...dateQuery(filters) };
  if (filters.sourceFileName) query.sourceFileName = { $regex: escapeRegex(filters.sourceFileName), $options: 'i' };
  if (reportIds) query.reportId = { $in: reportIds };
  return query;
}
function mappingQuery(clientId, filters) {
  const query = { clientId };
  if (filters.masterCategory) query.masterCategory = filters.masterCategory;
  if (filters.productCategory) query.$or = [{ productCategory: filters.productCategory }, { category: filters.productCategory }];
  if (filters.source) query.source = filters.source;
  if (filters.productSearch) query.originalExample = { $regex: escapeRegex(filters.productSearch), $options: 'i' };
  return query;
}
function suggestionQuery(clientId, filters) {
  const query = { clientId };
  if (filters.status) query.status = filters.status;
  if (filters.masterCategory) query.$and = [...(query.$and || []), { $or: [{ suggestedMasterCategory: filters.masterCategory }, { finalMasterCategory: filters.masterCategory }] }];
  if (filters.productCategory) query.$and = [...(query.$and || []), { $or: [{ suggestedProductCategory: filters.productCategory }, { finalProductCategory: filters.productCategory }] }];
  if (filters.productSearch) query.$and = [...(query.$and || []), { originalProductName: { $regex: escapeRegex(filters.productSearch), $options: 'i' } }];
  return query;
}
function textMatches(value, filter) { return !filter || String(value || '').toLowerCase().includes(filter.toLowerCase()); }
function exactMatches(value, filter) { return !filter || String(value || '') === filter; }
function reportMatches(report, filters) {
  return (!filters.sourceFileName || textMatches(report.sourceFileName, filters.sourceFileName))
    && (!filters.fromDate || new Date(report.createdAt) >= new Date(filters.fromDate + 'T00:00:00.000Z'))
    && (!filters.toDate || new Date(report.createdAt) <= new Date(filters.toDate + 'T23:59:59.999Z'));
}
function rowMatches(row, filters) { return exactMatches(row.category, filters.statusCategory) && exactMatches(row.masterCategory, filters.masterCategory) && exactMatches(row.productCategory, filters.productCategory); }
function mappingMatches(item, filters) {
  return exactMatches(item.masterCategory, filters.masterCategory)
    && (!filters.productCategory || item.productCategory === filters.productCategory || item.category === filters.productCategory)
    && exactMatches(item.source, filters.source)
    && textMatches(item.originalExample, filters.productSearch);
}
function suggestionMatches(item, filters) {
  return exactMatches(item.status, filters.status)
    && (!filters.masterCategory || item.suggestedMasterCategory === filters.masterCategory || item.finalMasterCategory === filters.masterCategory)
    && (!filters.productCategory || item.suggestedProductCategory === filters.productCategory || item.finalProductCategory === filters.productCategory)
    && textMatches(item.originalProductName, filters.productSearch);
}
function canonicalOrder(row) { return String(row.normalizedOrderId || row.orderId || row.originalOrderId || '').trim(); }

class DataManagementService {
  constructor({ reportStore, mappingStore, processingStore }) { this.reportStore = reportStore; this.mappingStore = mappingStore; this.processingStore = processingStore; }
  async reportList(clientId, filters, database) {
    let matchingIds = null;
    if (filters.statusCategory || filters.masterCategory || filters.productCategory) {
      if (database) matchingIds = await ReportRow.distinct('reportId', reportRowQuery(clientId, filters));
      else {
        const found = new Set();
        for (const [id, rows] of this.reportStore.rows) if (rows.some((row) => row.clientId === clientId && rowMatches(row, filters))) found.add(id);
        matchingIds = [...found];
      }
    }
    if (matchingIds && !matchingIds.length) return [];
    const query = reportQuery(clientId, filters, matchingIds);
    return database
      ? Report.find(query).select({ reportId: 1, sourceFileName: 1, sourceRowCount: 1, uniqueOrderCount: 1, analyticsRef: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean()
      : [...this.reportStore.memory.values()].filter((item) => item.clientId === clientId && item.reportStatus === 'completed' && reportMatches(item, filters) && (!matchingIds || matchingIds.includes(item.reportId))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  async preview(clientId, scope, input = {}) {
    const filters = cleanFilters(scope, input);
    if (scope === 'reports') {
      const database = await this.reportStore.database();
      const reports = await this.reportList(clientId, filters, database);
      const ids = reports.map((item) => item.reportId);
      let rows = 0; let orders = 0;
      if (database && ids.length) {
        rows = await ReportRow.countDocuments({ clientId, reportId: { $in: ids } });
        orders = (await ReportRow.distinct('normalizedOrderId', { clientId, reportId: { $in: ids } })).filter(Boolean).length;
      } else if (ids.length) {
        const all = ids.flatMap((id) => this.reportStore.rows.get(id) || []);
        rows = all.length; orders = new Set(all.map(canonicalOrder).filter(Boolean)).size;
      }
      return { scope, filters, counts: { reports: reports.length, rows, uniqueOrders: orders }, selectionFingerprint: fingerprint(ids), sampleFiles: reports.slice(0, 8).map((item) => item.sourceFileName || item.reportId), warning: 'Deletes entire matching reports and their derived Universal Report records, not only rows matching the category filter.' };
    }
    if (scope === 'product-mappings') {
      const database = await this.mappingStore.database(); const query = mappingQuery(clientId, filters);
      const selected = database ? await ProductMapping.find(query).select({ _id: 1 }).lean() : [...(this.mappingStore.memory.product.get(clientId)?.entries() || [])].filter(([, item]) => mappingMatches(item, filters)).map(([key]) => ({ _id: key }));
      return { scope, filters, counts: { mappings: selected.length }, selectionFingerprint: fingerprint(selected.map((item) => item._id)), warning: 'Deletes only matching product-to-category mappings. Uploaded reports and historical analytics remain unchanged.' };
    }
    const database = await this.mappingStore.database(); const query = suggestionQuery(clientId, filters);
    const selected = database ? await ProductClassificationSuggestion.find(query).select({ _id: 1 }).lean() : (this.mappingStore.memory.suggestion.get(clientId) || []).filter((item) => suggestionMatches(item, filters)).map((item) => ({ _id: item._id || [item.normalizedProductName, item.status, item.updatedAt || item.createdAt].join('|') }));
    return { scope, filters, counts: { suggestions: selected.length }, selectionFingerprint: fingerprint(selected.map((item) => item._id)), warning: 'Deletes only saved AI classification review suggestions. Product mappings, taxonomy, and uploaded reports remain unchanged.' };
  }
  async delete(clientId, scope, input = {}, expectedFingerprint) {
    const filters = cleanFilters(scope, input);
    if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) throw failure('Preview the selected data before deleting.', 'PREVIEW_REQUIRED', 409);
    if (scope === 'reports') return this.deleteReports(clientId, filters, expectedFingerprint);
    if (scope === 'product-mappings') return this.deleteMappings(clientId, filters, expectedFingerprint);
    if (scope === 'ai-suggestions') return this.deleteSuggestions(clientId, filters, expectedFingerprint);
    throw failure('Choose a supported data type.', 'INVALID_DATA_SCOPE');
  }
  async deleteReports(clientId, filters, expectedFingerprint) {
    const database = await this.reportStore.database(); const reports = await this.reportList(clientId, filters, database);
    const ids = reports.map((item) => item.reportId);
    if (fingerprint(ids) !== expectedFingerprint) throw stalePreview();
    if (!ids.length) return { scope: 'reports', deleted: { reports: 0, rows: 0, occurrences: 0, currentOrders: 0 } };
    let rowsDeleted = 0; let occurrencesDeleted = 0; let currentOrdersRebuilt = 0;
    if (database) {
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const cursor = UniversalOrderOccurrence.find({ clientId, reportId: { $in: batch } }).select({ canonicalOrderId: 1, productsRef: 1 }).lean().cursor({ batchSize: 500 });
        let orderIds = new Set(); let refs = [];
        const flush = async () => {
          const keys = [...orderIds]; if (!keys.length) return;
          if (refs.length) await ReportPayload.deleteMany({ clientId, $or: refs.map((ref) => ({ ownerId: ref.ownerId, generation: ref.generation })) });
          const result = await UniversalOrderOccurrence.deleteMany({ clientId, reportId: { $in: batch }, canonicalOrderId: { $in: keys } });
          occurrencesDeleted += result.deletedCount || 0;
          currentOrdersRebuilt += await this.rebuildCurrentOrders(clientId, keys, true);
          orderIds = new Set(); refs = [];
        };
        for await (const occurrence of cursor) {
          if (occurrence.canonicalOrderId) orderIds.add(occurrence.canonicalOrderId);
          if (occurrence.productsRef?.ownerId && occurrence.productsRef?.generation) refs.push({ ownerId: occurrence.productsRef.ownerId, generation: occurrence.productsRef.generation });
          if (orderIds.size >= 500) await flush();
        }
        await flush();
        await UniversalOrderOccurrence.deleteMany({ clientId, reportId: { $in: batch } });
      }
      const processes = await ReportProcess.find({ clientId, 'report.reportId': { $in: ids } }).select({ processId: 1 }).lean();
      if (processes.length) {
        await ReportPayload.deleteMany({ clientId, ownerId: { $in: processes.map((item) => item.processId) } });
        await ReportProcess.deleteMany({ clientId, processId: { $in: processes.map((item) => item.processId) } });
      }
      rowsDeleted = (await ReportRow.deleteMany({ clientId, reportId: { $in: ids } })).deletedCount || 0;
      await UniversalSync.deleteMany({ clientId, reportId: { $in: ids } });
      await ReportPayload.deleteMany({ clientId, ownerId: { $in: ids } });
      await Report.deleteMany({ clientId, reportId: { $in: ids } });
    } else {
      const store = this.reportStore.universalStore; const affected = new Set();
      for (const [key, item] of [...store.occurrences]) {
        if (item.clientId !== clientId || !ids.includes(item.reportId)) continue;
        if (item.canonicalOrderId) affected.add(item.canonicalOrderId);
        if (item.productsRef) await store.payloads.discard(clientId, item.productsRef.ownerId, item.productsRef);
        store.occurrences.delete(key); occurrencesDeleted += 1;
      }
      for (const id of ids) {
        const report = this.reportStore.memory.get(id);
        if (report?.analyticsRef) await this.reportStore.payloads.discard(clientId, id, report.analyticsRef);
        this.reportStore.memory.delete(id);
        const oldRows = this.reportStore.rows.get(id) || []; rowsDeleted += oldRows.length; this.reportStore.rows.delete(id);
        store.syncs.delete(store.key(clientId, id));
      }
      for (const [key, job] of [...this.processingStore.jobs]) if (job.clientId === clientId && ids.includes(job.report?.reportId)) {
        for (const ref of Object.values(job.payloads || {})) await this.processingStore.payloads.discard(clientId, job.processId, ref);
        this.processingStore.jobs.delete(key);
      }
      currentOrdersRebuilt = await this.rebuildCurrentOrders(clientId, [...affected], false);
    }
    return { scope: 'reports', deleted: { reports: ids.length, rows: rowsDeleted, occurrences: occurrencesDeleted, currentOrders: currentOrdersRebuilt } };
  }
  async rebuildCurrentOrders(clientId, canonicalIds, database) {
    if (!canonicalIds.length) return 0;
    if (database) {
      await UniversalOrder.deleteMany({ clientId, canonicalOrderId: { $in: canonicalIds } });
      const latest = await UniversalOrderOccurrence.aggregate([
        { $match: { clientId, canonicalOrderId: { $in: canonicalIds } } },
        { $sort: { reportCompletedAt: -1, reportId: -1 } },
        { $group: { _id: '$canonicalOrderId', item: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$item' } }
      ]);
      if (latest.length) await UniversalOrder.bulkWrite(latest.map((item) => {
        const projection = { clientId, canonicalOrderId: item.canonicalOrderId, originalOrderId: item.originalOrderId, latestReportId: item.reportId, latestReportCompletedAt: item.reportCompletedAt, orderDate: item.orderDate, originalStatus: item.originalStatus, normalizedStatus: item.normalizedStatus, statusCategory: item.statusCategory, paymentMode: item.paymentMode, courier: item.courier, orderSource: item.orderSource, products: item.products || [], totalQuantity: item.totalQuantity, totalValue: item.totalValue, ...(item.productsRef ? { productsRef: item.productsRef } : {}) };
        return { updateOne: { filter: { clientId, canonicalOrderId: item.canonicalOrderId }, update: { $set: projection, ...(!item.productsRef ? { $unset: { productsRef: 1 } } : {}) }, upsert: true } };
      }), { ordered: false });
      return latest.length;
    }
    const store = this.reportStore.universalStore;
    for (const id of canonicalIds) {
      const key = store.key(clientId, id);
      const latest = [...store.occurrences.values()].filter((item) => item.clientId === clientId && item.canonicalOrderId === id).sort((a, b) => new Date(b.reportCompletedAt) - new Date(a.reportCompletedAt) || String(b.reportId).localeCompare(String(a.reportId)))[0];
      if (!latest) { store.orders.delete(key); continue; }
      store.orders.set(key, { ...latest, latestReportId: latest.reportId, latestReportCompletedAt: latest.reportCompletedAt });
    }
    return canonicalIds.length;
  }
  async deleteMappings(clientId, filters, expectedFingerprint) {
    if (await this.mappingStore.database()) {
      const selected = await ProductMapping.find(mappingQuery(clientId, filters)).select({ _id: 1 }).lean();
      if (fingerprint(selected.map((item) => item._id)) !== expectedFingerprint) throw stalePreview();
      const ids = selected.map((item) => item._id);
      return { scope: 'product-mappings', deleted: { mappings: ids.length ? (await ProductMapping.deleteMany({ clientId, _id: { $in: ids } })).deletedCount || 0 : 0 } };
    }
    const values = this.mappingStore.memory.product.get(clientId); const selected = values ? [...values.entries()].filter(([, item]) => mappingMatches(item, filters)) : [];
    if (fingerprint(selected.map(([key]) => key)) !== expectedFingerprint) throw stalePreview();
    for (const [key] of selected) values.delete(key);
    return { scope: 'product-mappings', deleted: { mappings: selected.length } };
  }
  async deleteSuggestions(clientId, filters, expectedFingerprint) {
    if (await this.mappingStore.database()) {
      const selected = await ProductClassificationSuggestion.find(suggestionQuery(clientId, filters)).select({ _id: 1 }).lean();
      if (fingerprint(selected.map((item) => item._id)) !== expectedFingerprint) throw stalePreview();
      const ids = selected.map((item) => item._id);
      return { scope: 'ai-suggestions', deleted: { suggestions: ids.length ? (await ProductClassificationSuggestion.deleteMany({ clientId, _id: { $in: ids } })).deletedCount || 0 : 0 } };
    }
    const values = this.mappingStore.memory.suggestion.get(clientId) || []; const selected = values.filter((item) => suggestionMatches(item, filters));
    const keys = selected.map((item) => item._id || [item.normalizedProductName, item.status, item.updatedAt || item.createdAt].join('|'));
    if (fingerprint(keys) !== expectedFingerprint) throw stalePreview();
    const selectedSet = new Set(selected); const remaining = values.filter((item) => !selectedSet.has(item));
    this.mappingStore.memory.suggestion.set(clientId, remaining);
    return { scope: 'ai-suggestions', deleted: { suggestions: selected.length } };
  }
}
module.exports = { DataManagementService, cleanFilters };
