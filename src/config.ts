import { z } from "zod";

// D1 caps a row at about 2 MB (ADR 0003), so an Instance may not raise the limit past this.
export const MAX_BIN_BYTES_CEILING = 1_000_000;

const nonNegativeInt = z.coerce.number().int().nonnegative();

const booleanVar = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

const configSchema = z.object({
  MAX_BIN_BYTES: z.coerce.number().int().positive().max(MAX_BIN_BYTES_CEILING).default(102_400),
  DEFAULT_TTL_SECONDS: nonNegativeInt.default(0),
  MAX_TTL_SECONDS: nonNegativeInt.default(0),
  CORS_ORIGINS: z.string().trim().min(1).default("*"),
  RATE_LIMIT_ENABLED: booleanVar.default(true),
});

export type Config = {
  maxBinBytes: number;
  /** 0 means no default TTL. */
  defaultTtlSeconds: number;
  /** 0 means no maximum TTL. */
  maxTtlSeconds: number;
  /** "*" or an allowlist of origins. */
  corsOrigins: "*" | string[];
  rateLimitEnabled: boolean;
};

/** Parses the Instance's `vars`. Throws if a var is invalid. */
export function parseConfig(vars: object): Config {
  // An empty var means "unset", so its default applies.
  const present = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = configSchema.parse(present);
  return {
    maxBinBytes: parsed.MAX_BIN_BYTES,
    defaultTtlSeconds: parsed.DEFAULT_TTL_SECONDS,
    maxTtlSeconds: parsed.MAX_TTL_SECONDS,
    corsOrigins:
      parsed.CORS_ORIGINS === "*"
        ? "*"
        : parsed.CORS_ORIGINS.split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
    rateLimitEnabled: parsed.RATE_LIMIT_ENABLED,
  };
}
