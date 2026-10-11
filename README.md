# DeliveryIQ

DeliveryIQ is a single Express, MongoDB/Mongoose, and Vercel application for delivery reporting. Upload one **Full Report** CSV/XLSX template, review deterministic status mappings and Gemini-assisted product suggestions, and return to persisted reports.

## Full Report template

The Full Report requires `Order ID`, `Order Date`, `Order Status`, `Product Name`, `Product Qty`, `Product Price`, `Payment Mode`, `Courier`, and `Source/Website/Store`.

Download the CSV or Excel template from Upload Data. Product Price is a **unit price**; row value is quantity × unit price. Order metrics count distinct Order IDs; product metrics retain every product row.

## Run and verify

```bash
npm install
npm start
npm test
npm run check
```

Raw uploads are transient. Completed report metadata, normalized rows needed for filters/exports, and analytics are persisted in MongoDB when configured; local development falls back to process memory.

## Product classification

Uploading validates the selected template, basic row data, and summary counts only. On report generation, DeliveryIQ checks saved client product mappings and reusable suggestions before sending unique unknown product names to the server-side **Gemini 2.5 Flash-Lite** model in sequential batches of up to 100. Only active master names and product-category/master pairs from the current client are sent; Gemini must select an existing pair or return `NO_MATCH`. AI never creates categories or permanent mappings. Clients approve existing suggestions or select/create categories manually. Failed suggestions can be retried; rejected suggestions require an explicit reclassification action, with prior decisions retained. Names unsupported by normalization remain visible for manual assignment. `GEMINI_API_KEY` stays server-side.
