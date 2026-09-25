# Business rules

Final status categories are Delivered, In Transit, NDR, RTO, Cancelled, and Other. Resolution is saved client mapping, deterministic rules (with RTO precedence), then `UNMAPPED`; `UNMAPPED` is never reported as Other.

Product classification is saved client mapping, deterministic product rule, optional server-side AI provider, then review. Products are normalized/deduplicated before classification. AI results require a matching product, normalized non-empty category, and confidence from 0 to 1; only confidence ≥0.80 is automatic. No provider is enabled by default.

Order-level totals and percentages use distinct Order ID, including after filters. Full Product Price is treated as a unit price; revenue is Product Qty × Product Price. CSV exports prefix formula-leading values with an apostrophe.
