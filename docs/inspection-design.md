# Inspection and foundation design

## Current architecture

DeliveryIQ is a single CommonJS Node.js application. `api/index.js` exports the Express app for Vercel and starts it locally. `src/app.js` applies HTTP middleware, serves the static browser application, and exposes the health route. Browser assets remain in `public/`; no build step or secondary application is needed.

## Inspection findings

- The deployment rewrites send API requests to the Express entry point and public requests to static assets. They are appropriate for the existing one-project Vercel deployment and remain unchanged.
- The backend has Helmet, restricted CORS, a 1 MB JSON limit, API rate limiting, and the Express fingerprint disabled. It has no data routes, authentication, database connection, uploads, or tenant access yet.
- The previous frontend was a health-check landing page with no product navigation. Its responsive behavior was limited to a fluid heading.
- Automated testing covered only the API health endpoint. This milestone adds a static-shell assertion; browser interaction and upload processing need future coverage.
- There is no duplication, generated output, or deployment-breaking configuration in the inspected repository.

## Product structure

The application shell now presents Dashboard, Upload Data, Reports, Product Mapping, Status Mapping, Report History, and Settings. Dashboard starts with report context, filters, an upload action, compact KPI placeholders, and three drill-down-oriented analytics areas rather than every analysis on one page. Upload Data explains the CSV/XLSX, 50,000-row workflow and its six visible processing phases. The remaining pages establish focused, plain-language destinations for the next milestones.

Mobile navigation becomes a compact menu; metrics use a two-column grid and only future data tables should scroll horizontally when necessary.

## Minimum persistence design

The first persistence milestone should add Mongoose models for `User`, `Client`, `Upload`, `Order`, `Product`, `ProductMapping`, `ProductCategory`, `StatusMapping`, `Report`, and `AuditLog`. Every client-owned model must carry a server-derived client reference and every query must scope to it. Orders need a stable order identifier plus separate product-row representation so reports count distinct orders without losing quantities. Product categories and mappings are client-specific; status resolution is client mapping first, generic mapping second, then internal review. Only the six final categories are reportable; unmapped is not a category.

## Next implementation milestone

Implement authenticated, tenant-scoped upload intake and server-side CSV/XLSX validation. Enforce the 50,000-row cap and required columns, return detected columns and invalid/duplicate-row summaries, and add tests before introducing report calculations or persistence of finalized reports.
