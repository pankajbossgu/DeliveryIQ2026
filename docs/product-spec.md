# Product specification

DeliveryIQ converts client-uploaded e-commerce order and delivery files into delivery intelligence. It is a multi-tenant SaaS product, not a generic courier dashboard.

## Intended workflow

1. Upload a CSV or XLSX file (up to 50,000 source rows).
2. Validate, normalize, and identify unique orders and products.
3. Apply saved client status and product mappings, then present uncertain mappings for review.
4. Calculate backend-authoritative analytics and let users filter, export, and retain report history.

## Product areas

The planned application has Dashboard, Upload Data, Reports, Product Mapping, Status Mapping, Report History, and Settings areas. The current milestone provides only the deployable foundation and landing page; upload, authentication, persistence, mappings, analytics, and exports are deliberately not implemented yet.
