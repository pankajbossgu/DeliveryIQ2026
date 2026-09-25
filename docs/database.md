# Database plan

MongoDB is the single persistent datastore. Mongoose models will be added with explicit tenant ownership before data features ship.

Planned tenant-scoped collections:

- clients and authenticated users;
- reports and normalized order/product rows;
- client status mappings and client product mappings.

Every client-owned query must derive the client scope from authenticated server-side identity, never a browser-supplied tenant ID. Raw uploads are processed transiently and should not be retained unless a future documented requirement requires it.
