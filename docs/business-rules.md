# Business rules

Final status categories are Delivered, In Transit, NDR, RTO, Cancelled, and Other. Resolution is saved client mapping, deterministic rules (with RTO precedence), then `UNMAPPED`; `UNMAPPED` is never reported as Other.

An Order ID is one order. The upload preserves `originalOrderId` and uses a conservative whitespace/Unicode-normalized value for uniqueness. Product rows remain intact, exact duplicate source rows are warned about, and conflicting order-level date, status, payment, courier, or source values stop generation for review.

Product classification is database-first: saved client mappings are reused in one batch for unique normalized products and never sent to Gemini. Unique unknown products are submitted in batches to server-side Gemini 2.5 Flash-Lite for review-only suggestions. A client must approve, modify, or reject each suggestion before a final mapping is saved. Gemini never creates a category or mapping automatically; failed, invalid, and rejected suggestions require manual assignment. Approved mappings are marked AI Approved, changed suggestions Client Modified, and fallback assignments Manual.

Full Product Price is a unit price, so row value is Product Qty × Product Price. Order metrics and percentages use distinct normalized Order IDs, including after filters. Report rows store the category used during generation, so changing a current mapping does not alter historical reports. CSV exports prefix formula-leading values with an apostrophe.
