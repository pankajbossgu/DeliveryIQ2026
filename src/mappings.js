const mongoose = require('mongoose');
const { isReportCategory, normalizeMappingValue } = require('./classification');

const mappingSchema = new mongoose.Schema({ clientId: { type: String, required: true }, normalizedValue: { type: String, required: true }, originalExample: { type: String, required: true }, category: { type: String, required: true } }, { timestamps: true, versionKey: false });
mappingSchema.index({ clientId: 1, normalizedValue: 1 }, { unique: true });
const StatusMapping = mongoose.models.StatusMapping || mongoose.model('StatusMapping', mappingSchema, 'statusMappings');
const ProductMapping = mongoose.models.ProductMapping || mongoose.model('ProductMapping', mappingSchema, 'productMappings');

class MappingStore {
  constructor({ mongoUri = process.env.MONGODB_URI } = {}) { this.mongoUri = mongoUri; this.memory = { status: new Map(), product: new Map() }; this.connection = null; }
  async database() { if (!this.mongoUri || this.mongoUri.includes('127.0.0.1:27017/deliveryiq2026') && process.env.NODE_ENV === 'test') return null; if (!this.connection) this.connection = mongoose.connect(this.mongoUri, { serverSelectionTimeoutMS: 1500 }).catch(() => null); return this.connection; }
  async list(kind, clientId) { const Model = kind === 'status' ? StatusMapping : ProductMapping; if (await this.database()) return Model.find({ clientId }).lean(); return [...(this.memory[kind].get(clientId)?.values() || [])]; }
  async save(kind, clientId, originalExample, category) {
    if ((kind === 'status' && !isReportCategory(category)) || (kind === 'product' && !String(category ?? '').trim())) { const error = new Error('INVALID_CATEGORY'); error.code = 'INVALID_CATEGORY'; throw error; }
    const normalizedValue = normalizeMappingValue(originalExample); if (!clientId || !normalizedValue) { const error = new Error('INVALID_MAPPING'); error.code = 'INVALID_MAPPING'; throw error; }
    const update = { clientId, normalizedValue, originalExample: String(originalExample).trim(), category };
    const Model = kind === 'status' ? StatusMapping : ProductMapping;
    if (await this.database()) return Model.findOneAndUpdate({ clientId, normalizedValue }, update, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    const values = this.memory[kind].get(clientId) || new Map(); const previous = values.get(normalizedValue); const record = { ...previous, ...update, createdAt: previous?.createdAt || new Date(), updatedAt: new Date() }; values.set(normalizedValue, record); this.memory[kind].set(clientId, values); return record;
  }
}
module.exports = { MappingStore };
