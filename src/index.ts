import { OpenAPIHono } from "@hono/zod-openapi";
import { binRoutes } from "./bins/routes";
import type { AppEnv } from "./context";
import { ApiError, errorResponse } from "./errors";

export const app = new OpenAPIHono<AppEnv>();

// Last write wins, so a cached response could be stale (docs/api.md → Conventions).
app.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

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
  // The Expiry sweep is added in TODO §7.
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
