import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sweepExpired } from "./bins/expiry";
import { binRoutes } from "./bins/routes";
import { type AppEnv, withConfig } from "./context";
import { withCors } from "./cors";
import { ApiError, errorResponse } from "./errors";
import { BEARER_AUTH, docsPage, errorResponses, SPEC_INFO } from "./openapi";

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

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Instance"],
  summary: "Check that the Instance is up",
  description: "Needs no key and doesn't touch D1.",
  responses: {
    200: {
      description: "The Instance is up.",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
    ...errorResponses("internal_error"),
  },
});

app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));

app.route("/bins", binRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", BEARER_AUTH, {
  type: "http",
  scheme: "bearer",
  description: "A Bin's Write Key (`kj_w_…`) or Read Key (`kj_r_…`), as `Authorization: Bearer <key>`.",
});

// The spec and its viewer describe every route registered above. Like /health, they need no key, aren't rate limited
// and don't touch D1. The spec is built once, on first use, when every route is registered.
let spec: ReturnType<typeof app.getOpenAPI31Document> | undefined;
app.get("/openapi.json", (c) => {
  spec ??= app.getOpenAPI31Document({ openapi: "3.1.0", info: SPEC_INFO });
  return c.json(spec);
});
app.get("/docs", (c) => c.html(docsPage("/openapi.json")));

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
