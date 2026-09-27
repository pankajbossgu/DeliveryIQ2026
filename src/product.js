const crypto = require('node:crypto');
const { normalizeMappingValue } = require('./classification');

// Preserve existing mapping keys. Names unsupported by the legacy normalizer get
// a separate identity so they cannot disappear or collide with ordinary names.
function normalizeProductName(value) {
  const raw = String(value ?? '').trim();
  return normalizeMappingValue(raw) || (raw ? `raw:${crypto.createHash('sha256').update(raw.normalize('NFKC')).digest('hex')}` : '');
}
function normalizeCategory(value) { const text = String(value || '').trim().replace(/\s+/g, ' '); return text ? text.slice(0, 80) : null; }
function validAiCategory(value) { return typeof value === 'string' && value.trim().length <= 80 && !/[\u0000-\u001f\u007f<>]/.test(value) ? normalizeCategory(value) : null; }
function categoryKey(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function buildTaxonomy(productCategories = [], masterCategories = []) {
  const masters = new Map(masterCategories.filter((x) => typeof x === 'string' || x.active !== false).map((x) => typeof x === 'string' ? x : x.name).filter(validAiCategory).map((name) => [categoryKey(name), name]));
  const pairs = new Map();
  for (const category of productCategories) {
    if (!category || category.active === false || !validAiCategory(category.name)) continue;
    const masterCategory = masters.get(categoryKey(category.masterCategory));
    if (masterCategory) pairs.set(JSON.stringify([categoryKey(masterCategory), categoryKey(category.name)]), { name: category.name, masterCategory });
  }
  return { masterCategories: [...masters.values()], productCategories: [...pairs.values()] };
}
function matchTaxonomyPair(taxonomy, master, product) {
  return taxonomy.productCategories.find((x) => categoryKey(x.masterCategory) === categoryKey(master) && categoryKey(x.name) === categoryKey(product)) || null;
}
function reviewState(item, status, reason) {
  Object.assign(item, { suggestedCategory: null, suggestedProductCategory: null, suggestedMasterCategory: null, confidence: null, suggestionReason: null, mappingSource: 'needs-review', classificat: true, classificationRequired: true, suggestionStatus: status, manualReason: reason });
}
function classifyProducts(products, { mappings = [], categories = [], masterCategories = [], productCategories, suggestions = [], provider, retry = false } = {}) {
  const current = buildTaxonomy(productCategories || categories, masterCategories);
  const unique = new Map();
  for (const value of products) {
    const originalProductName = String(value ?? '').trim(); const normalizedProductName = normalizeProductName(originalProductName);
    if (!originalProductName) continue;
    const item = unique.get(normalizedProductName) || { value: originalProductName, originalProductName, normalizedProductName, manualOnly: !normalizeMappingValue(originalProductName), count: 0 };
    item.count += 1; unique.set(normalizedProductName, item);
  }
  const saved = new Map(mappings.map((m) => [m.normalizedValue || m.normalizedProductName, m]));
  const prior = new Map(suggestions.map((s) => [s.normalizedProductName, s])); const pending = [];
  const items = [...unique.values()].map((item) => {
    const mapping = saved.get(item.normalizedProductName);
    const productCategory = normalizeCategory(mapping?.productCategory || mapping?.category);
    const masterCategory = normalizeCategory(mapping?.masterCategory);
    // A product is ONLY fully mapped when BOTH masterCategory AND productCategory exist.
    // If either is missing, treat it as incomplete and send to Gemini/review.
    const isFullyMapped = productCategory && masterCategory;
    Object.assign(item, { category: productCategory, productCategory, masterCategory, confidence: isFullyMapped ? 1 : null, mappingSource: isFullyMapped ? 'client' : 'unmapped', classificationRequired: !isFullyMapped });
    if (isFullyMapped) return item;
    const previous = prior.get(item.normalizedProductName);
    item.suggestionHistory = previous?.history || [];
    if (item.manualOnly) { reviewState(item, 'Needs Review', 'This product name requires manual category selection. Its original name has been preserved.'); return item; }
    if (!retry && previous?.status === 'Client Rejected') { reviewState(item, 'Client Rejected', 'You rejected the previous suggestion. Select categories manually or explicitly reclassify this product.'); return item; }
    const pair = previous?.status === 'AI Suggested' && matchTaxonomyPair(current, previous.suggestedMasterCategory, previous.suggestedProductCategory || previous.suggestedCategory);
    if (!retry && pair) {
      Object.assign(item, { suggestedCategory: pair.name, suggestedProductCategory: pair.name, suggestedMasterCategory: pair.masterCategory, confidence: previous.confidence ?? null, suggestionReason: previous.reason || null, mappingSource: 'ai-suggested', suggestionStatus: 'AI Suggested', model: previous.model || null }); return item;
    }
    // Failed/legacy Needs Review and stale suggestions are eligible again. Empty
    // taxonomies are sent to Gemini so it can propose the first valid pair.
    pending.push(item); return item;
  });
  const apply = async (response = {}) => {
    const byProduct = new Map((response.results || []).map((x) => [x.product, x]));
    for (const item of pending) {
      const suggestion = byProduct.get(item.originalProductName);
      const pair = suggestion && matchTaxonomyPair(current, suggestion.masterCategory, suggestion.productCategory || suggestion.category);
      if (pair || suggestion && suggestion.productCategory !== 'NO_MATCH' && suggestion.category !== 'NO_MATCH' && suggestion.masterCategory) {
        // Gemini output is review-only. Reuse the canonical existing pair when
        // available, otherwise retain its proposed pair without creating taxonomy.
        const suggestedMasterCategory = pair?.masterCategory || normalizeCategory(suggestion.masterCategory);
        const suggestedProductCategory = pair?.name || normalizeCategory(suggestion.productCategory || suggestion.category);
        Object.assign(item, {
          suggestedCategory: suggestedProductCategory,
          suggestedProductCategory,
          suggestedMasterCategory,
          confidence: typeof suggestion.confidence === 'number' ? suggestion.confidence : null,
          suggestionReason: suggestion.reason || null,
          mappingSource: 'ai-suggested',
          suggestionStatus: 'AI Suggested',
          model: response.model || null
        });
      }
      else if (suggestion?.productCategory === 'NO_MATCH' || suggestion?.category === 'NO_MATCH') reviewState(item, 'No Match', 'No suitable existing category was found. Please select master and product categories manually.');
      else reviewState(item, 'Failed', 'AI classification could not be completed. Retry or select categories manually.');
      item.model = response.model || null;
    }
    return { providerUnavailable: Boolean(response.providerUnavailable) || items.some((x) => x.suggestionStatus === 'Failed'), providerError: response.providerError || null, items };
  };
  if (!pending.length) return { providerUnavailable: false, items };
  if (!provider) return apply();
  try {
    const response = provider.classifyProducts(pending.map((x) => x.originalProductName), current);
    return response?.then ? response.then(apply, () => apply({ providerUnavailable: true })) : apply(response);
  } catch { return apply({ providerUnavailable: true }); }
}
module.exports = { normalizeProductName, normalizeCategory, validAiCategory, buildTaxonomy, matchTaxonomyPair, classifyProducts };
