import { OpenAPIHono } from "@hono/zod-openapi";

export const app = new OpenAPIHono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

export default {
  fetch: app.fetch,
  // The Expiry sweep is added in TODO §7.
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
