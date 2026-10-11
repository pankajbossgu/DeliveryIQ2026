const test = require('node:test');
const assert = require('node:assert/strict');
const { DataManagementService } = require('../src/data-management');
const { ReportStore, ProcessingStore } = require('../src/reports');
const { MappingStore } = require('../src/mappings');

function row({ orderId = 'ORD-1', product = 'Hair Serum', master = 'Beauty', category = 'Hair Serum', status = 'Delivered', value = 100 } = {}) {
  return {
    orderId, originalOrderId: orderId, normalizedOrderId: orderId, orderDate: '2026-09-20',
    category: status, originalStatus: status, normalizedStatus: status.toLowerCase(),
    originalProductName: product, normalizedProductName: product.toLowerCase().replace(/\s+/g, '-'),
    masterCategory: master, productCategory: category, paymentMode: 'Prepaid', courier: 'Test Courier',
    orderSource: 'Test Store', quantity: 1, productPrice: value, rowValue: value
  };
}
function service() {
  const reportStore = new ReportStore({ mongoUri: null });
  const mappingStore = new MappingStore({ mongoUri: null });
  const processingStore = new ProcessingStore({ mongoUri: null });
  return { reportStore, mappingStore, processingStore, manager: new DataManagementService({ reportStore, mappingStore, processingStore }) };
}

test('report cleanup previews matching full datasets and rebuilds current orders from retained history', async () => {
  const { reportStore, manager } = service();
  const older = await reportStore.create('tenant-a', { templateType: 'full', sourceFileName: 'older.csv', rows: [row()] });
  const newer = await reportStore.create('tenant-a', { templateType: 'full', sourceFileName: 'newer.csv', rows: [row({ product: 'Water Bottle', master: 'Home', category: 'Drinkware', status: 'RTO', value: 250 })] });
  await reportStore.create('tenant-b', { templateType: 'full', sourceFileName: 'other-tenant.csv', rows: [row({ orderId: 'ORD-X' })] });

  const preview = await manager.preview('tenant-a', 'reports', { sourceFileName: 'newer', masterCategory: 'Home', productCategory: 'Drinkware' });
  assert.deepEqual(preview.counts, { reports: 1, rows: 1, uniqueOrders: 1 });
  assert.deepEqual(preview.sampleFiles, ['newer.csv']);
  assert.match(preview.warning, /entire matching reports/);

  const deleted = await manager.delete('tenant-a', 'reports', { sourceFileName: 'newer', masterCategory: 'Home', productCategory: 'Drinkware' }, preview.selectionFingerprint);
  assert.deepEqual(deleted.deleted, { reports: 1, rows: 1, occurrences: 1, currentOrders: 1 });
  assert.equal((await reportStore.list('tenant-a')).length, 1);
  assert.equal((await reportStore.list('tenant-b')).length, 1);
  const current = reportStore.universalStore.orders.get(reportStore.universalStore.key('tenant-a', 'ORD-1'));
  assert.equal(current.latestReportId, older.reportId);
  assert.equal(current.statusCategory, 'Delivered');
  assert.equal(current.products[0].originalProductName, 'Hair Serum');
  assert.notEqual(current.latestReportId, newer.reportId);
});

test('product mapping cleanup is filtered and never crosses tenant boundaries', async () => {
  const { mappingStore, manager } = service();
  await mappingStore.save('product', 'tenant-a', 'Serum A', 'Hair Serum', { source: 'Manual' });
  await mappingStore.save('product', 'tenant-a', 'Serum B', 'Skin Serum', { source: 'AI Approved' });
  await mappingStore.save('product', 'tenant-b', 'Serum A', 'Hair Serum', { source: 'Manual' });
  const filters = { productSearch: 'Serum A', productCategory: 'Hair Serum', source: 'Manual' };
  const preview = await manager.preview('tenant-a', 'product-mappings', filters);
  assert.deepEqual(preview.counts, { mappings: 1 });
  const result = await manager.delete('tenant-a', 'product-mappings', filters, preview.selectionFingerprint);
  assert.deepEqual(result.deleted, { mappings: 1 });
  assert.equal((await mappingStore.list('product', 'tenant-a')).length, 1);
  assert.equal((await mappingStore.list('product', 'tenant-b')).length, 1);
});

test('cleanup refuses to delete records added after the preview', async () => {
  const { reportStore, manager } = service();
  await reportStore.create('tenant-a', { templateType: 'full', sourceFileName: 'target.csv', rows: [row()] });
  const preview = await manager.preview('tenant-a', 'reports', { sourceFileName: 'target.csv' });
  await reportStore.create('tenant-a', { templateType: 'full', sourceFileName: 'target.csv', rows: [row({ orderId: 'ORD-2' })] });
  await assert.rejects(manager.delete('tenant-a', 'reports', { sourceFileName: 'target.csv' }, preview.selectionFingerprint), (error) => error.code === 'PREVIEW_STALE' && error.status === 409);
  assert.equal((await reportStore.list('tenant-a')).length, 2);
});

test('cleanup rejects unsupported filters and invalid date ranges', async () => {
  const { manager } = service();
  await assert.rejects(manager.preview('tenant-a', 'reports', { arbitraryMongoQuery: { $ne: null } }), /not supported/);
  await assert.rejects(manager.preview('tenant-a', 'reports', { fromDate: '2026-10-01', toDate: '2026-09-01' }), /on or before/);
  await assert.rejects(manager.delete('tenant-a', 'unknown', {}), /supported data type/);
});
