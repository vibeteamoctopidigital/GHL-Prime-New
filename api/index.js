/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this per request instead of running a long-lived process, so
 * there is deliberately no `app.listen()` here — that lives in src/server.ts,
 * which is what `npm start` uses for a normal server.
 *
 * An Express app is itself an `(req, res)` handler, so exporting it directly is
 * all Vercel needs.
 *
 * This imports from `dist/`, which `npm run vercel-build` produces before the
 * function is bundled. Keeping the entry as plain JavaScript means Vercel never
 * has to compile TypeScript itself, so what runs in production is exactly the
 * output `tsc` was verified against locally.
 */

import createApp from '../dist/src/app.js'

const app = createApp()

export default app
