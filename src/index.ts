import { OpenAPIHono } from "@hono/zod-openapi";
import { sweepExpired } from "./bins/expiry";
import { binRoutes } from "./bins/routes";
import { type AppEnv, withConfig } from "./context";
import { withCors } from "./cors";
import { ApiError, errorResponse } from "./errors";

export const app = new OpenAPIHono<AppEnv>();

// Last write wins, so a cached response could be stale (docs/api.md → Conventions).
app.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// Before the routes, so every response carries the CORS headers, errors from notFound and onError included, and
// preflights are answered before any route-level middleware such as the rate limiter.
app.use(withConfig);
app.use(withCors);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/bins", binRoutes);

app.notFound((c) => errorResponse(c, 404, "not_found", "Not found"));

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err.status, err.code, err.message);
  // Only the error's name: a message could quote request data, and requests can carry keys.
  console.error(`Unhandled ${err.name}`);
  return errorResponse(c, 500, "internal_error", "Internal error");
});

export default {
  fetch: app.fetch,
  // The hourly Cron Trigger: deletes expired Bins (docs/api.md → Expiry rules). Requests already treat them as gone.
  async scheduled(_controller, env, _ctx) {
    const deleted = await sweepExpired(env.DB, Date.now());
    console.log(`Expiry sweep deleted ${deleted} Bins`);
  },
} satisfies ExportedHandler<Env>;
