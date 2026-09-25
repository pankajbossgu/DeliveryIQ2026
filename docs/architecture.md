# Architecture

DeliveryIQ is one deployment and one application:

- `api/index.js` is the Express serverless entry point for Vercel and local startup.
- `src/app.js` owns HTTP middleware, API routing, and static frontend delivery.
- `public/` contains the browser UI without a frontend build system.
- MongoDB and Mongoose will provide persistence when product features are implemented.

This milestone intentionally avoids separate frontend/backend apps, Vercel Services, queues, workflows, and microservices. Future business logic should remain in the existing `src/` modules unless a cohesive new domain module is necessary.

The foundation applies Helmet, CORS restricted to `APP_ORIGIN`, JSON body limits, API rate limiting, and disabled Express fingerprints. Authentication and tenant authorization are required before client data endpoints are added.
