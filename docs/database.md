# Database

`statusMappings` and `productMappings` use unique `{ clientId, normalizedValue }` indexes. `reports` has `clientId`, `createdAt`, and idempotent `{ clientId, requestId }` indexing. `reportRows` carry report/client IDs and date index for report filtering. Reports store summary metadata and calculated analytics; normalized rows, rather than raw files, are stored only to support filters and exports.
