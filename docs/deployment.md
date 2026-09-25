# Deployment

Deploy this repository as one Vercel project. Vercel invokes `api/index.js` for `/api/*`; the `public/` directory provides the browser interface. `vercel.json` contains the only routing configuration needed.

## Environment variables

Configure `NODE_ENV`, `MONGODB_URI`, `APP_ORIGIN`, and `SESSION_SECRET` in Vercel. Do not commit production values. Use `.env.example` only as a template.

## Local verification

1. Run `npm install`.
2. Run `npm start`.
3. Visit `http://localhost:3000/` and `http://localhost:3000/api/health`.

Before deploying features, run `npm test` and `npm run check`.
