const { normalizeMappingValue } = require('./classification');

// This deliberately normalizes formatting only. Variants such as a colour suffix remain distinct.
function normalizeProductName(value) { return normalizeMappingValue(value); }
function normalizeCategory(value) {
  const category = String(value || '').trim().replace(/\s+/g, ' ');
  return category ? category.slice(0, 80) : null;
}
function classifyProducts(products, { mappings = [], categories = [], suggestions = [], provider } = {}) {
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
  const prior = new Map(suggestions.map((suggestion) => [suggestion.normalizedProductName, suggestion]));
  const unknown = items.filter((item) => item.classificationRequired);
  const pending = unknown.filter((item) => !prior.has(item.normalizedProductName));
  for (const item of unknown.filter((entry) => prior.has(entry.normalizedProductName))) {
    const suggestion = prior.get(item.normalizedProductName);
    if (suggestion.status === 'AI Suggested' && suggestion.suggestedCategory && (!categories.length || categories.includes(suggestion.suggestedCategory))) Object.assign(item, { suggestedCategory: suggestion.suggestedCategory, confidence: suggestion.confidence ?? null, suggestionReason: suggestion.reason || null, mappingSource: 'ai-suggested', classificationRequired: true, suggestionStatus: 'AI Suggested', model: suggestion.model || null });
    else Object.assign(item, { mappingSource: 'needs-review', classificationRequired: true, suggestionStatus: suggestion.status, manualReason: suggestion.status === 'Client Rejected' ? 'AI suggestion rejected. Please assign a category to continue.' : 'AI could not classify this product. Please assign a category manually.' });
  }
  // A category suggested for a new tenant remains a review-only suggestion.
  if (!provider || !pending.length) return { providerUnavailable: false, items };
  const applySuggestions = (response) => { const suggested = new Map(response.results.map((item) => [item.product, item])); for (const item of pending) { const suggestion = suggested.get(item.originalProductName); if (suggestion?.category && suggestion.category !== 'NO_MATCH') Object.assign(item, { suggestedCategory: suggestion.category, confidence: suggestion.confidence, suggestionReason: suggestion.reason, mappingSource: 'ai-suggested', classificationRequired: true, suggestionStatus: 'AI Suggested', model: response.model }); else Object.assign(item, { mappingSource: 'needs-review', suggestionStatus: suggestion?.category === 'NO_MATCH' ? 'NO_MATCH' : 'Needs Review', classificationRequired: true, manualReason: suggestion?.category === 'NO_MATCH' ? 'No suitable existing category was found. Please assign a category.' : 'AI could not classify this product. Please assign a category manually.', model: response.model }); } return { providerUnavailable: Boolean(response.providerUnavailable), providerError: response.providerError || null, items }; };
  const response = provider.classifyProducts(pending.map((item) => item.originalProductName), categories);
  return response?.then ? response.then(applySuggestions) : applySuggestions(response);
}

module.exports = { normalizeProductName, normalizeCategory, classifyProducts };
