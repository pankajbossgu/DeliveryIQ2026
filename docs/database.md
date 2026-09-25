# Database

`statusMappings` and `productMappings` use unique `{ clientId, normalizedValue }` indexes. `reports` has `clientId`, `createdAt`, and idempotent `{ clientId, requestId }` indexing. `reportRows` carry report/client IDs and date index for report filtering. Reports store summary metadata and calculated analytics; normalized rows, rather than raw files, are stored only to support filters and exports.

`universalOrders` enforces unique `{ clientId, normalizedOrderId }` current-state records. `universalOrderOccurrences` enforces unique `{ clientId, reportId, normalizedOrderId }` immutable observations and is indexed by client/universal order/time for history queries. `universalSyncs` enforces unique `{ clientId, reportId }` durable synchronization state. These records remain client-scoped and do not mutate Delivery Reports or their rows.
