# Product specification

Upload accepts one Full Report CSV/XLSX format with order, date, status, product, quantity, unit price, payment mode, courier, and source/store fields. Server validation accepts documented aliases, validates date-only values without timezone shifts, and blocks invalid fields. Unknown statuses remain `UNMAPPED`; unknown/low-confidence products require review. A report is created only after both are resolved.

Reports persist template type and display available dimensions. Reports, filtered detail data, and formula-safe CSV exports are server-authoritative. Universal Report offers one download action for the full current-order CSV using the active filters.
