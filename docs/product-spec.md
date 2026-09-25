# Product specification

Upload starts by selecting Simple or Full. Server validation accepts CSV/XLSX and documented aliases, validates date-only values without timezone shifts, and blocks invalid fields. Unknown statuses remain `UNMAPPED`; unknown/low-confidence products require review. A report is created only after both are resolved.

Reports persist template type and display only available dimensions. Both include status, date, product, product category, and payment-mode performance. Full adds quantity, unit-price revenue, courier, and source/store performance. Reports, filtered detail data, and formula-safe CSV exports are server-authoritative.
