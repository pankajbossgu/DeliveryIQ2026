const { normalizeMappingValue } = require('./classification');

// This deliberately normalizes formatting only. Variants such as a colour suffix remain distinct.
function normalizeProductName(value) { return normalizeMappingValue(value); }
function normalizeCategory(value) {
  const category = String(value || '').trim().replace(/\s+/g, ' ');
  return category ? category.slice(0, 80) : null;
}
function classifyProducts(products, { mappings = [], categories = [], provider } = {}) {
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
  const items = [...unique.values()].map((item) => {
    const category = normalizeCategory(saved.get(item.normalizedProductName));
    return { ...item, category, confidence: category ? 1 : null, mappingSource: category ? 'client' : 'unmapped', classificationRequired: !category };
  });
  const unknown = items.filter((item) => item.classificationRequired);
  // A category suggested for a new tenant remains a review-only suggestion.
  if (!provider || !unknown.length) return { providerUnavailable: false, items };
  const applySuggestions = (response) => { const suggestions = new Map(response.results.map((item) => [item.product, item])); for (const item of unknown) { const suggestion = suggestions.get(item.originalProductName); if (suggestion) Object.assign(item, { suggestedCategory: suggestion.category, confidence: suggestion.confidence, suggestionReason: suggestion.reason, mappingSource: 'ai-suggested', classificationRequired: true, suggestionStatus: 'AI Suggested', model: response.model }); else Object.assign(item, { mappingSource: 'needs-review', suggestionStatus: 'Needs Review', classificationRequired: true, model: response.model }); } return { providerUnavailable: Boolean(response.providerUnavailable), items }; };
  const response = provider.classifyProducts(unknown.map((item) => item.originalProductName), categories);
  return response?.then ? response.then(applySuggestions) : applySuggestions(response);
}

module.exports = { normalizeProductName, normalizeCategory, classifyProducts };
