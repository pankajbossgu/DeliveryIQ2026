# Architecture

DeliveryIQ is one Express/MongoDB/Vercel application: `api/index.js` exposes the Express entry point, `src/` holds server business rules and persistence, and `public/` holds the browser application. No raw upload file is retained.

`src/upload.js` parses bounded CSV/XLSX uploads (10 MB, 50,000 rows), validates the selected Simple or Full template, normalizes order/product identifiers, and performs order-level conflict checks. `src/mappings.js` provides tenant-scoped status mappings, product mappings, and product categories. `src/reports.js` creates immutable report-row snapshots and computes server-side analytics.

MongoDB is used when `MONGODB_URI` is configured; a non-durable in-memory fallback supports demos and tests. The server owns the temporary `DEFAULT_CLIENT_ID` scope—request query parameters never choose a client. Real authentication must replace this development identity before production multi-tenancy.

## Universal Report read API

The rate-limited `/api/universal` routes derive scope from the same server-owned client context as the rest of the application; `clientId` query, path, and body values are ignored. They are read-only: synchronization remains part of completed-report persistence.

- `GET /api/universal/orders` returns the current `UniversalOrder` projection with `{ success, orders, pagination }`. It accepts positive `page` (default 1) and `limit` (default 25, maximum 100), canonical-order-ID prefix `search`, exact latest `status`, `statusCategory`, order-date `fromDate`/`toDate`, and latest-report completion `reportFromDate`/`reportToDate`. Dates use strict UTC `YYYY-MM-DD` values. `sortBy` is limited to `latestReportCompletedAt`, `orderDate`, `createdAt`, `totalValue`, `totalQuantity`, or `canonicalOrderId`; `sortDirection` is `asc` or `desc`.
- `GET /api/universal/orders/:orderId` returns `{ success, order }` for the current projection. `GET /api/universal/orders/:orderId/history` returns immutable `UniversalOrderOccurrence` evidence as `{ success, occurrences, pagination }`, with the same pagination/date filters and deterministic report-completion/report-ID descending order.
- `GET /api/universal/summary` accepts the same allow-listed current-order filters as the orders endpoint and returns `{ success, summary }`, with current-order totals, quantity/value, and latest category/actual-status counts for that filtered dataset.
- `GET /api/universal/analytics` accepts those same filters and returns a client-scoped, current-order-only analytics payload: KPI/RTO totals, category and actual-status distributions, order-date/value trend points, up to ten product-line aggregates, and objective RTO attention data. MongoDB evaluates these facets after the tenant-scoped match; the browser never receives all orders to calculate analytics.

Malformed pagination, dates, filter values, or sort values return `422` with `INVALID_UNIVERSAL_QUERY`; inaccessible or missing orders return `404`. Empty client datasets return valid empty collections and zero-valued summaries.

## Product intelligence

`src/upload.js` performs bounded parsing and validation only. The MongoDB-backed `ReportProcess` store in `src/reports.js` persists each validated process and its complete classification review snapshot across browser refreshes and serverless restarts; only its explicit start endpoint loads mappings and invokes classification. `src/product-classifier.js` is the only Gemini boundary. It uses the hardcoded Gemini 2.5 Flash-Lite model and server-only `GEMINI_API_KEY`, sending only a deduplicated list of unknown product names plus the authenticated client's active categories. `src/product.js` first applies client product mappings by normalized product name; it never calls the provider for those mappings. Suggestions are validated against the request batch and category allow-list when one exists (or a concise proposed category for a new client), stored separately for audit, and remain review-only until a client saves an `AI Approved`, `Client Modified`, or `Manual` mapping. Failed, timed-out, or partial AI requests leave products in Needs Review without losing the upload.
