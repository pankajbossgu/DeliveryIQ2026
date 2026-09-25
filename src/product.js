const { normalizeMappingValue } = require('./classification');

// This deliberately normalizes formatting only. Variants such as a colour suffix remain distinct.
function normalizeProductName(value) { return normalizeMappingValue(value); }
function normalizeCategory(value) {
  const category = String(value || '').trim().replace(/\s+/g, ' ');
  return category ? category.slice(0, 80) : null;
}
function validAiCategory(value) {
  const category = normalizeCategory(value);
  return category && !/[\u0000-\u001f\u007f<>]/.test(category) ? category : null;
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
    const suggestedCategory = validAiCategory(suggestion.suggestedCategory);
    if (suggestion.status === 'AI Suggested' && suggestedCategory) Object.assign(item, { suggestedCategory, confidence: suggestion.confidence ?? null, suggestionReason: suggestion.reason || null, mappingSource: 'ai-suggested', classificationRequired: true, suggestionStatus: 'AI Suggested', model: suggestion.model || null });
    else Object.assign(item, { mappingSource: 'needs-review', classificationRequired: true, suggestionStatus: suggestion.status, manualReason: suggestion.status === 'Client Rejected' ? 'AI suggestion rejected. Please assign a category to continue.' : 'AI could not classify this product. Please assign a category manually.' });
  }
  // A category suggested for a new tenant remains a review-only suggestion.
  if (!provider || !pending.length) return { providerUnavailable: false, items };
  const applySuggestions = (response) => { const suggested = new Map(response.results.map((item) => [item.product, item])); let noMatchCount = 0; let failedCount = 0; const newCategories = new Set(); for (const item of pending) { const suggestion = suggested.get(item.originalProductName); const suggestedCategory = validAiCategory(suggestion?.category); if (suggestedCategory && suggestedCategory !== 'NO_MATCH') { if (!categories.some((category) => category.toLocaleLowerCase() === suggestedCategory.toLocaleLowerCase())) newCategories.add(suggestedCategory); Object.assign(item, { suggestedCategory, confidence: suggestion.confidence, suggestionReason: suggestion.reason, mappingSource: 'ai-suggested', classificationRequired: true, suggestionStatus: 'AI Suggested', model: response.model }); } else { if (suggestion?.category === 'NO_MATCH') noMatchCount += 1; else failedCount += 1; Object.assign(item, { mappingSource: 'needs-review', suggestionStatus: suggestion?.category === 'NO_MATCH' ? 'NO_MATCH' : 'Needs Review', classificationRequired: true, manualReason: suggestion?.category === 'NO_MATCH' ? 'AI could not confidently classify this product. Please assign a category manually.' : 'AI could not classify this product. Please assign a category manually.', model: response.model }); } } if (process.env.NODE_ENV !== 'production') console.info(JSON.stringify({ event: 'gemini_classification_summary', successfulClassifications: pending.length - noMatchCount - failedCount, newAiCategories: [...newCategories], noMatchCount, failedClassifications: failedCount })); return { providerUnavailable: Boolean(response.providerUnavailable), providerError: response.providerError || null, items }; };
  const response = provider.classifyProducts(pending.map((item) => item.originalProductName), categories);
  return response?.then ? response.then(applySuggestions) : applySuggestions(response);
}

module.exports = { normalizeProductName, normalizeCategory, classifyProducts };
