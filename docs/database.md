# Database plan

MongoDB is the single persistent datastore. The mapping abstraction now uses Mongoose `statusMappings` and `productMappings` when `MONGODB_URI` is configured, with a unique `{ clientId, normalizedValue }` index and upserted timestamps. It falls back to process memory for local/no-database operation; that fallback is intentionally not durable.

Planned tenant-scoped collections:

- clients and authenticated users;
- reports and normalized order/product rows;
- client status mappings and client product mappings.

Every client-owned query must derive the client scope from authenticated server-side identity, never a browser-supplied tenant ID. Raw uploads are processed transiently and should not be retained unless a future documented requirement requires it.
