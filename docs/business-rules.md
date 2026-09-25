# Business rules

Final status categories are Delivered, In Transit, NDR, RTO, Cancelled, and Other. Resolution is saved client mapping, deterministic rules (with RTO precedence), then `UNMAPPED`; `UNMAPPED` is never reported as Other.

An Order ID is one order. The upload preserves `originalOrderId` and uses a conservative whitespace/Unicode-normalized value for uniqueness. Product rows remain intact, exact duplicate source rows are warned about, and conflicting order-level date, status, payment, courier, or source values stop generation for review.

Product classification is deliberately manual in this phase: saved client mapping, then Needs Classification. Categories are client-managed; saved mappings are consulted in one batch against unique normalized products. No product rules, AI provider, AI dependency, or API key is used. A future Gemini phase should classify only unique unknown products and require client approval before saving a mapping.

Full Product Price is a unit price, so row value is Product Qty × Product Price. Order metrics and percentages use distinct normalized Order IDs, including after filters. Report rows store the category used during generation, so changing a current mapping does not alter historical reports. CSV exports prefix formula-leading values with an apostrophe.
