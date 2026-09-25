# Database

`statusMappings` and `productMappings` use unique `{ clientId, normalizedValue }` indexes. `reports` has `clientId`, `createdAt`, and idempotent `{ clientId, requestId }` indexing. `reportRows` carry report/client IDs and date index for report filtering. Reports store summary metadata and calculated analytics; normalized rows, rather than raw files, are stored only to support filters and exports.

## Universal report foundation

Completed delivery reports are synchronized after their report and normalized rows are persisted. `UniversalOrder` is the current tenant-scoped order projection, uniquely keyed by `{ clientId, canonicalOrderId }`. `UniversalOrderOccurrence` is immutable evidence of an order as observed in one completed report, uniquely keyed by `{ clientId, reportId, canonicalOrderId }`; its product line array preserves multi-product orders. `UniversalSync`, uniquely keyed by `{ clientId, reportId }`, records the idempotent synchronization state and counts.

The projection chooses its state solely by `reportCompletedAt`; equal timestamps use lexical `reportId` ordering as the deterministic tie-breaker. Order dates are never used for this decision. All universal reads, writes, upserts, and indexes include `clientId`. A sync failure records a safe failed sync status and never changes the already-completed delivery report.
