# Business rules

## Uploads

- Accept CSV and XLSX files with no more than 50,000 rows.
- Require Order ID, Order Date, Status, Product Name, Order Quantity, Payment Mode, and Order Source. Other specified delivery and customer fields are optional.
- One order can have multiple product rows. Order metrics use distinct Order ID; quantity metrics sum valid product-row quantities.

## Statuses

Final reporting categories are Delivered, In Transit, NDR, RTO, Cancelled, and Other. Unmapped values are an internal review state, never a seventh reporting category.

New Order, Order Created, Order Received, New, Pending, Payment Confirmed, and Processing must not map automatically to In Transit. Shipping progress such as Ready to Ship, Label Generated, Manifested, Picked Up, Shipped, In Transit, At Hub, or OFD can map to In Transit.

The only report categories are **Delivered**, **In Transit**, **NDR**, **RTO**, **Cancelled**, and **Other**. An unrecognized value is `UNMAPPED` internally: it has no report category, requires review, and blocks report generation. DeliveryIQ never guesses that an unknown value is Other.

Status values are normalized for case, whitespace, hyphen, underscore, slash, and benign punctuation differences while retaining the original courier value for audit. Resolution is deterministic: saved client mapping, RTO, NDR, Delivered, Cancelled, forward shipment/In Transit, Other, then UNMAPPED. RTO context always wins, so RTO Delivered, RTO NDR, RTO OFD, and RTO In Transit are all RTO. Generic pickup failures remain unmapped.

Client-approved status mappings override generic mappings and are saved for reuse. The current unauthenticated application uses a server-owned demo client scope; authenticated server-derived client identity must replace that scope before multi-tenant production use.

## Products and analytics

Product categories are client-specific and configured with `PRODUCT_CATEGORIES` (comma-separated; the development default is Apparel, Beauty, Electronics, Home, Other). Mapping precedence is saved client mapping, generic mapping when configured, then client review. Product mappings are independent from status classification.

All metrics and filtered exports are calculated authoritatively on the backend. Percentages use the filtered distinct-order total as their denominator.
