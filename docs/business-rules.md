# Business rules

## Uploads

- Accept CSV and XLSX files with no more than 50,000 rows.
- Require Order ID, Order Date, Status, Product Name, Order Quantity, Payment Mode, and Order Source. Other specified delivery and customer fields are optional.
- One order can have multiple product rows. Order metrics use distinct Order ID; quantity metrics sum valid product-row quantities.

## Statuses

Final reporting categories are Delivered, In Transit, NDR, RTO, Cancelled, and Other. Unmapped values are an internal review state, never a seventh reporting category.

New Order, Order Created, Order Received, New, Pending, Payment Confirmed, and Processing must not map automatically to In Transit. Shipping progress such as Ready to Ship, Label Generated, Manifested, Picked Up, Shipped, In Transit, At Hub, or OFD can map to In Transit.

Client-approved status mappings override generic mappings and are saved for reuse.

## Products and analytics

Product categories are client-specific. Mapping precedence is saved client mapping, deterministic normalized match, similarity match, optional AI assistance for uncertainty, then client review. AI cannot silently overwrite client-approved mappings.

All metrics and filtered exports are calculated authoritatively on the backend. Percentages use the filtered distinct-order total as their denominator.
