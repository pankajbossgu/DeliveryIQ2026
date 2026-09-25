# DeliveryIQ2026 contributor guide

## Architecture

- Keep this repository a single Node.js, Express, MongoDB, and Vercel application.
- Serve the browser application from `public/` and expose the serverless entry point from `api/index.js`.
- Keep business rules authoritative on the server. Do not add a separate frontend, backend, deployment, queue, or microservice project.
- Prefer extending the existing `src/` modules over creating narrowly scoped files.

## Delivery practices

- Validate all client input on the server and scope future database access to the authenticated tenant.
- Do not commit secrets, uploads, generated coverage, or dependencies.
- Add or update tests when implementing a business rule.
- Keep documentation in `docs/` concise and aligned with the implementation.

## Local checks

Run `npm test` and `npm run check` before submitting implementation changes. Use `npm start` to smoke-test the app locally.
