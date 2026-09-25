# Product specification

DeliveryIQ converts client-uploaded e-commerce order and delivery files into delivery intelligence. It is a multi-tenant SaaS product, not a generic courier dashboard.

## Intended workflow

1. Upload a CSV or XLSX file (up to 50,000 source rows).
2. Validate, normalize, and identify unique orders and products.
3. Apply saved client status and product mappings, then present uncertain mappings for review.
4. Calculate backend-authoritative analytics and let users filter, export, and retain report history.

## Product areas

The application shell has Dashboard, Upload Data, Reports, Product Mapping, Status Mapping, Report History, and Settings areas. Upload intake and validation are implemented; authentication, persistence, mapping decisions, analytics, and exports remain future phases.

## Phase 2 upload intake

The upload page validates CSV and XLSX files before a report workflow starts. Files are limited to 10 MB and 50,000 non-blank source rows. Required headers are Order ID, Order Date, Status, Product Name, Order Quantity, Payment Mode, and Order Source; common, explicit header aliases such as `Order-ID` and `Qty` are accepted. The page offers CSV and Excel templates with sample-only data.

`POST /api/uploads/validate` is the server-authoritative validation endpoint. It accepts the file bytes as `application/octet-stream` and a filename in `X-File-Name`; responses summarize detected columns, distinct orders, product rows, warnings, and blocking row errors. Identical source rows are reported as warnings and never removed; different product rows for the same order remain valid. Mapping and reporting remain later phases.
