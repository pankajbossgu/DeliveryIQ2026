# DeliveryIQ

DeliveryIQ is a single-application e-commerce delivery intelligence platform. It will transform client CSV/XLSX order and delivery data into normalized delivery analytics, client-specific mappings, filtered reports, and exports.

> **Current milestone:** secure upload intake, validation, templates, and review UI. Authentication, persistence, mappings, analytics, and exports remain future work.

## Stack and layout

- Node.js and Express API in `api/index.js` and `src/`
- Static HTML, CSS, and JavaScript interface in `public/`
- MongoDB and Mongoose for upcoming persistence
- One Vercel project configured by `vercel.json`

```
api/       Vercel/Express entry point
docs/      concise product and operational documentation
public/    browser interface
src/       application modules
tests/     automated checks
```

## Get started

1. Copy `.env.example` to `.env` and set appropriate local values.
2. Install dependencies: `npm install`.
3. Start the app: `npm start`.
4. Open `http://localhost:3000/`; the health endpoint is at `http://localhost:3000/api/health`.

## Checks

```bash
npm test
npm run check
```

## Deployment

Deploy the repository as a single Vercel project. `/api/*` is handled by the Express entry point and `/` is served from `public/`. Configure the environment variables documented in `.env.example`; never commit real secrets. See [deployment documentation](docs/deployment.md) for details.

## Documentation

- [Product specification](docs/product-spec.md)
- [Business rules](docs/business-rules.md)
- [Architecture](docs/architecture.md)
- [Database plan](docs/database.md)
- [Deployment](docs/deployment.md)
- [Inspection and foundation design](docs/inspection-design.md)
