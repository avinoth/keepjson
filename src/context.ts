import { createMiddleware } from "hono/factory";
import { type Config, parseConfig } from "./config";

export type AppEnv = { Bindings: Env; Variables: { config: Config } };

/** Sets `c.var.config` from the Instance's `vars`. */
export const withConfig = createMiddleware<AppEnv>(async (c, next) => {
  c.set("config", parseConfig(c.env));
  await next();
});
