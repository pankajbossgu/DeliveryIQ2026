# Architecture

DeliveryIQ remains one Express application (`api/index.js`, `src/`, `public/`). `src/upload.js` parses bounded CSV/XLSX uploads; `src/product.js` supplies normalization, deterministic rules, and a replaceable server-side AI-provider boundary; `src/reports.js` calculates analytics and persists reports/normalized rows. No raw upload file is retained.

MongoDB is used when `MONGODB_URI` is configured; a non-durable in-memory fallback supports local demos. The server owns the temporary `DEFAULT_CLIENT_ID` scope. Authentication must replace it with server-derived identity before production multi-tenancy.
