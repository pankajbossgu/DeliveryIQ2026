# DeliveryIQ

DeliveryIQ is a single Express, MongoDB/Mongoose, and Vercel application for delivery reporting. Clients select a **Simple** or **Full** report template, upload CSV/XLSX data, review deterministic status mappings and Gemini-assisted product suggestions, and return to persisted reports.

## Report templates

- **Simple:** `Order ID`, `Order Date`, `Order Status`, `Product Name`, `Payment Mode`.
- **Full:** Simple fields plus `Product Qty`, `Product Price`, `Courier`, and `Source/Website/Store`.

Download each CSV/XLSX template from Upload Data. Full-template Product Price is a **unit price**; row value is quantity × unit price. Order metrics count distinct Order IDs; product metrics retain every product row.

## Run and verify

```bash
npm install
npm start
npm test
npm run check
```

Raw uploads are transient. Completed report metadata, normalized rows needed for filters/exports, and analytics are persisted in MongoDB when configured; local development falls back to process memory.

## Product classification

DeliveryIQ first reuses saved client product mappings. Only unique, unknown product names are sent server-side to **Gemini 2.5 Flash-Lite** in batches. Gemini suggestions are review-only: clients approve, change, or reject them before a final mapping is saved. Clients may create an AI-suggested category explicitly, but Gemini never creates categories or mappings automatically.
