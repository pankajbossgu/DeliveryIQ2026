# Database

`statusMappings` and `productMappings` use unique `{ clientId, normalizedValue }` indexes. `reports` has `clientId`, `createdAt`, and idempotent `{ clientId, requestId }` indexing. `reportRows` carry report/client IDs and date index for report filtering. Reports store summary metadata and calculated analytics; normalized rows, rather than raw files, are stored only to support filters and exports.

## Universal report foundation

Completed delivery reports are synchronized after their report and normalized rows are persisted. `UniversalOrder` is the current tenant-scoped order projection, uniquely keyed by `{ clientId, canonicalOrderId }`. `UniversalOrderOccurrence` is immutable evidence of an order as observed in one completed report, uniquely keyed by `{ clientId, reportId, canonicalOrderId }`; its product line array preserves multi-product orders. `UniversalSync`, uniquely keyed by `{ clientId, reportId }`, records the idempotent synchronization state and counts.

The projection chooses its state solely by `reportCompletedAt`; equal timestamps use lexical `reportId` ordering as the deterministic tie-breaker. Order dates are never used for this decision. All universal reads, writes, upserts, and indexes include `clientId`. A sync failure records a safe failed sync status and never changes the already-completed delivery report.

## Bounded report process storage

Uploads support 35,000 non-empty source rows and 10 MB. The shared browser/Node limits live in `public/js/limits.js`. `ReportProcess` stores metadata and references, not source rows or complete review arrays. `reportPayloads` stores immutable JSON byte chunks of at most 2 MiB, indexed by client, owner, generation, and chunk index. Input rows are stored once; status and product reviews are separate snapshots. Report analytics use the same bounded storage, with only the status distribution kept on the report metadata for lists.

A new snapshot is fully written before its reference is published using a revision compare-and-swap. Definite conflicts leave the previous snapshot authoritative and discard their new chunks. Ambiguous publication errors retain chunks because the reference may already have committed. Superseded snapshots expire after a 24-hour reader grace period via a TTL index. Interrupted writes before publication can leave unreferenced generations; maintenance may remove only generations proven unreferenced by reports, processes, Universal orders, and Universal occurrences, after a grace period. Active references never expire. Legacy inline processes remain readable and move to chunk storage when fully saved.

Progress/cancellation writes update metadata only. Polling and review routes omit input rows; processing/finalization explicitly load them. Suggestion upserts and final report-row/Universal writes run in bounded batches. Gemini batching, retries, taxonomy context, saved-mapping precedence, and review requirements are unchanged.

Universal orders whose complete projection approaches 8 MiB keep product arrays in the same immutable chunk store; current-order, history, grouped-report, analytics, and export reads rehydrate them. Analytics retains database summary/status/trend aggregation, streams inline product aggregates, and hydrates only orders with external products before merging product totals and selecting the top ten. A later small projection clears the external reference. This preserves single-order uploads with many product lines without exceeding the BSON limit.

Oversized Universal product snapshots use generations derived from tenant, owner, and exact content. Identical retries upsert missing immutable chunks without creating another generation; changed contents use a different generation and preserve older occurrences. Failed report creation removes analytics chunks only after a definite rejection and confirmation that no report references them. Ambiguous errors retain data for recovery.
