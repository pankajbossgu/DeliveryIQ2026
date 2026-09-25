# Architecture

DeliveryIQ is one Express/MongoDB/Vercel application: `api/index.js` exposes the Express entry point, `src/` holds server business rules and persistence, and `public/` holds the browser application. No raw upload file is retained.

`src/upload.js` parses bounded CSV/XLSX uploads (10 MB, 50,000 rows), validates the selected Simple or Full template, normalizes order/product identifiers, and performs order-level conflict checks. `src/mappings.js` provides tenant-scoped status mappings, product mappings, and product categories. `src/reports.js` creates immutable report-row snapshots and computes server-side analytics.

MongoDB is used when `MONGODB_URI` is configured; a non-durable in-memory fallback supports demos and tests. The server owns the temporary `DEFAULT_CLIENT_ID` scope—request query parameters never choose a client. Real authentication must replace this development identity before production multi-tenancy.
