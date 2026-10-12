import type { Config } from "../config";
import { ApiError } from "../errors";

/**
 * Validates a create/replace request body in order: content type (415), size (413),
 * JSON (400), top-level type (422). Returns the body text exactly as received.
 */
export async function parseBinBody(request: Request, config: Config): Promise<string> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (declaredLength > config.maxBinBytes) throw payloadTooLarge(config);

  const bytes = await readAtMost(request, config.maxBinBytes);
  if (bytes === null) throw payloadTooLarge(config);

  let content: string;
  let value: unknown;
  try {
    // fatal: invalid UTF-8 is not JSON. ignoreBOM: keep the bytes as sent rather than dropping a BOM.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(content);
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON");
  }

  if (typeof value !== "object" || value === null) {
    throw new ApiError(422, "invalid_top_level", "Body must be a JSON object or array");
  }
  return content;
}

/** `application/json`, optionally with parameters such as `; charset=utf-8`. */
function isJsonContentType(header: string | null): boolean {
  return header?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** The body's bytes, or null as soon as it is longer than `limit` bytes. */
async function readAtMost(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function payloadTooLarge(config: Config): ApiError {
  return new ApiError(413, "payload_too_large", `Body is larger than ${config.maxBinBytes} bytes`);
}
