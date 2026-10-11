# Product specification

Upload accepts one Full Report CSV/XLSX format with order, date, status, product, quantity, unit price, payment mode, courier, and source/store fields. Server validation accepts documented aliases, validates date-only values without timezone shifts, and blocks invalid fields. Unknown statuses remain `UNMAPPED`; unknown/low-confidence products require review. A report is created only after both are resolved.

Reports persist template type and display available dimensions. Reports, filtered detail data, and formula-safe CSV exports are server-authoritative. Universal Report offers one download action for the full current-order CSV using the active filters.


## Workspace settings

The Settings page offers preview-first cleanup for uploaded report datasets, saved product mappings, and AI classification suggestions. Upload deletion filters can narrow by source filename, upload date, status category, master category, and product category; any matching report is deleted as a whole, including derived current-order projections. Mapping/suggestion cleanup does not remove reports. Deletion requires a fresh preview and typing `DELETE`; taxonomy categories are preserved to protect historical references. Log out remains available in the account-security section.
