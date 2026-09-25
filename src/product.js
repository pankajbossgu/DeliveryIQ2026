const { normalizeMappingValue } = require('./classification');

// This deliberately normalizes formatting only. Variants such as a colour suffix remain distinct.
function normalizeProductName(value) { return normalizeMappingValue(value); }
function normalizeCategory(value) {
  const category = String(value || '').trim().replace(/\s+/g, ' ');
  return category ? category.slice(0, 80) : null;
}
function classifyProducts(products, { mappings = [] } = {}) {
  const unique = new Map();
  for (const value of products) {
    const originalProductName = String(value || '').trim();
    const normalizedProductName = normalizeProductName(originalProductName);
    if (!normalizedProductName) continue;
    const item = unique.get(normalizedProductName) || { value: originalProductName, originalProductName, normalizedProductName, count: 0 };
    item.count += 1;
    unique.set(normalizedProductName, item);
  }
  const saved = new Map(mappings.map((mapping) => [mapping.normalizedValue || mapping.normalizedProductName, mapping.category]));
  return { providerUnavailable: false, items: [...unique.values()].map((item) => {
    const category = normalizeCategory(saved.get(item.normalizedProductName));
    return { ...item, category, confidence: category ? 1 : null, mappingSource: category ? 'client' : 'unmapped', classificationRequired: !category };
  }) };
}

module.exports = { normalizeProductName, normalizeCategory, classifyProducts };
