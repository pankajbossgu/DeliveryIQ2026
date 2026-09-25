const mongoose = require('mongoose');
const { isReportCategory, normalizeMappingValue } = require('./classification');
const { normalizeCategory } = require('./product');

const mappingSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, normalizedValue: { type: String, required: true }, originalExample: { type: String, required: true },
  category: { type: String, required: true }, source: { type: String, default: null }, updatedBy: { type: String, default: 'system' }, previousCategory: String
}, { timestamps: true, versionKey: false });
mappingSchema.index({ clientId: 1, normalizedValue: 1 }, { unique: true });
mappingSchema.index({ clientId: 1, category: 1 });
const categorySchema = new mongoose.Schema({ clientId: { type: String, required: true }, name: { type: String, required: true }, normalizedName: { type: String, required: true }, active: { type: Boolean, default: true }, updatedBy: { type: String, default: 'system' } }, { timestamps: true, versionKey: false });
categorySchema.index({ clientId: 1, normalizedName: 1 }, { unique: true });
const StatusMapping = mongoose.models.StatusMapping || mongoose.model('StatusMapping', mappingSchema, 'statusMappings');
const ProductMapping = mongoose.models.ProductMapping || mongoose.model('ProductMapping', mappingSchema, 'productMappings');
const ProductCategory = mongoose.models.ProductCategory || mongoose.model('ProductCategory', categorySchema, 'productCategories');

class MappingStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) { this.mongoUri = mongoUri; this.memory = { status: new Map(), product: new Map(), category: new Map() }; this.connection = null; }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  async list(kind, clientId) { const Model = kind === 'status' ? StatusMapping : ProductMapping; if (await this.database()) return Model.find({ clientId }).sort({ updatedAt: -1 }).lean(); return [...(this.memory[kind].get(clientId)?.values() || [])].sort((a, b) => b.updatedAt - a.updatedAt); }
  async save(kind, clientId, originalExample, category, options = {}) {
    const finalCategory = kind === 'product' ? normalizeCategory(category) : category;
    if ((kind === 'status' && !isReportCategory(finalCategory)) || (kind === 'product' && !finalCategory)) { const error = new Error('INVALID_CATEGORY'); error.code = 'INVALID_CATEGORY'; throw error; }
    const normalizedValue = normalizeMappingValue(originalExample); if (!clientId || !normalizedValue) { const error = new Error('INVALID_MAPPING'); error.code = 'INVALID_MAPPING'; throw error; }
    const Model = kind === 'status' ? StatusMapping : ProductMapping;
    const update = { clientId, normalizedValue, originalExample: String(originalExample).trim(), category: finalCategory, source: options.source || null, updatedBy: options.updatedBy || 'client' };
    if (await this.database()) { const previous = await Model.findOne({ clientId, normalizedValue }).lean(); return Model.findOneAndUpdate({ clientId, normalizedValue }, { ...update, ...(previous?.category !== finalCategory ? { previousCategory: previous?.category } : {}) }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean(); }
    const values = this.memory[kind].get(clientId) || new Map(); const previous = values.get(normalizedValue); const record = { ...previous, ...update, ...(previous?.category !== finalCategory ? { previousCategory: previous?.category } : {}), createdAt: previous?.createdAt || new Date(), updatedAt: new Date() }; values.set(normalizedValue, record); this.memory[kind].set(clientId, values); return record;
  }
  async remove(kind, clientId, normalizedValue) { const key = normalizeMappingValue(normalizedValue); const Model = kind === 'status' ? StatusMapping : ProductMapping; if (await this.database()) return Boolean((await Model.deleteOne({ clientId, normalizedValue: key })).deletedCount); return (this.memory[kind].get(clientId)?.delete(key)) || false; }
  async listCategories(clientId, includeInactive = false) { if (await this.database()) return ProductCategory.find({ clientId, ...(includeInactive ? {} : { active: true }) }).sort({ name: 1 }).lean(); return [...(this.memory.category.get(clientId)?.values() || [])].filter((item) => includeInactive || item.active).sort((a, b) => a.name.localeCompare(b.name)); }
  async saveCategory(clientId, name, options = {}) { const value = normalizeCategory(name); if (!clientId || !value) { const error = new Error('INVALID_CATEGORY'); error.code = 'INVALID_CATEGORY'; throw error; } const normalizedName = normalizeMappingValue(value); const update = { clientId, name: value, normalizedName, active: options.active !== false, updatedBy: options.updatedBy || 'client' }; if (await this.database()) return ProductCategory.findOneAndUpdate({ clientId, normalizedName }, update, { upsert: true, new: true, setDefaultsOnInsert: true }).lean(); const values = this.memory.category.get(clientId) || new Map(); const previous = values.get(normalizedName); const record = { ...previous, ...update, createdAt: previous?.createdAt || new Date(), updatedAt: new Date() }; values.set(normalizedName, record); this.memory.category.set(clientId, values); return record; }
  async setCategoryActive(clientId, name, active) { const key = normalizeMappingValue(name); if (await this.database()) { const category = await ProductCategory.findOneAndUpdate({ clientId, normalizedName: key }, { active: Boolean(active), updatedBy: 'client' }, { new: true }).lean(); return category; } const category = this.memory.category.get(clientId)?.get(key); if (!category) return null; category.active = Boolean(active); category.updatedAt = new Date(); return category; }
  async renameCategory(clientId, oldName, name) { const oldKey = normalizeMappingValue(oldName); const next = normalizeCategory(name); if (!next) throw Object.assign(new Error('INVALID_CATEGORY'), { code: 'INVALID_CATEGORY' }); if (await this.database()) { const category = await ProductCategory.findOne({ clientId, normalizedName: oldKey }); if (!category) return null; category.name = next; category.normalizedName = normalizeMappingValue(next); await category.save(); await ProductMapping.updateMany({ clientId, category: oldName }, { category: next, previousCategory: oldName, updatedAt: new Date() }); return category.toObject(); } const values = this.memory.category.get(clientId); const category = values?.get(oldKey); if (!category) return null; values.delete(oldKey); const updated = { ...category, name: next, normalizedName: normalizeMappingValue(next), updatedAt: new Date() }; values.set(updated.normalizedName, updated); for (const mapping of this.memory.product.get(clientId)?.values() || []) if (mapping.category === oldName) { mapping.previousCategory = oldName; mapping.category = next; mapping.updatedAt = new Date(); } return updated; }
}
module.exports = { MappingStore };
