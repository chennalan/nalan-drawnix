interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_ORIGIN: string;
}

interface AccessClaims {
  sub?: string;
  email?: string;
  aud?: string[] | string;
  iss?: string;
  exp?: number;
  nbf?: number;
}

interface DocumentRow {
  id: string;
  title: string;
  revision: number;
  payload_bytes: number;
  created_at: string;
  updated_at: string;
}

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const TITLE_MAX_LENGTH = 160;

function json(data: unknown, status = 200, origin = ""): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "vary": "Origin",
      } : {}),
    },
  });
}

function getOrigin(request: Request, env: Env): string {
  const origin = request.headers.get("Origin") || "";
  return origin === env.ALLOWED_ORIGIN ? origin : "";
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "600",
    ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "vary": "Origin" } : {}),
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

async function verifyAccessJwt(request: Request, env: Env): Promise<AccessClaims> {
  const accessAssertion = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const authorization = request.headers.get("Authorization") || "";
  const token = accessAssertion || (authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
  if (!token) throw new Error("UNAUTHORIZED");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("UNAUTHORIZED");

  const header = decodeJsonPart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJsonPart<AccessClaims>(parts[1]);
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issuer = `https://${teamDomain}`;

  if (header.alg !== "RS256" || !header.kid) throw new Error("UNAUTHORIZED");
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer || !claims.sub || !claims.exp || claims.exp <= nowSeconds || (claims.nbf !== undefined && claims.nbf > nowSeconds + 60)) {
    throw new Error("UNAUTHORIZED");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.ACCESS_AUD)) throw new Error("UNAUTHORIZED");

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { "accept": "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  const jwks = await response.json() as { keys?: (JsonWebKey & { kid?: string; alg?: string })[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("UNAUTHORIZED");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64Url(parts[2]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) throw new Error("UNAUTHORIZED");
  return claims;
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") return "未命名画板";
  const title = value.trim().slice(0, TITLE_MAX_LENGTH);
  return title || "未命名画板";
}

function parsePayload(value: unknown): { text: string; bytes: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_PAYLOAD");
  }
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  return { text, bytes };
}

function isId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const origin = getOrigin(request, env);
  if (request.headers.get("Origin") && !origin) return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  let claims: AccessClaims;
  try {
    claims = await verifyAccessJwt(request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return json({ error: message === "AUTH_PROVIDER_UNAVAILABLE" ? "AUTH_PROVIDER_UNAVAILABLE" : "UNAUTHORIZED" }, message === "AUTH_PROVIDER_UNAVAILABLE" ? 503 : 401, origin);
  }

  const ownerId = claims.sub!;
  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "api" || segments[1] !== "documents") {
    return json({ error: "NOT_FOUND" }, 404, origin);
  }

  if (segments.length === 2 && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id, title, revision, payload_bytes, created_at, updated_at FROM documents WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 500",
    ).bind(ownerId).all<DocumentRow>();
    return json({ documents: result.results || [] }, 200, origin);
  }

  if (segments.length === 2 && request.method === "POST") {
    let body: { title?: unknown; content?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ error: "INVALID_JSON" }, 400, origin); }
    let payload: { text: string; bytes: number };
    try { payload = parsePayload(body.content); } catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      return json({ error: message }, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, origin);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const objectKey = `users/${encodeURIComponent(ownerId)}/documents/${id}.json`;
    await env.DOCS.put(objectKey, payload.text, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
    try {
      await env.DB.prepare(
        "INSERT INTO documents (id, owner_id, title, object_key, revision, payload_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
      ).bind(id, ownerId, normalizeTitle(body.title), objectKey, payload.bytes, now, now).run();
    } catch {
      await env.DOCS.delete(objectKey);
      return json({ error: "SAVE_FAILED" }, 500, origin);
    }
    return json({ id, title: normalizeTitle(body.title), revision: 1, updated_at: now }, 201, origin);
  }

  if (segments.length === 3) {
    const id = segments[2];
    if (!isId(id)) return json({ error: "NOT_FOUND" }, 404, origin);
    const row = await env.DB.prepare(
      "SELECT id, owner_id, title, object_key, revision, payload_bytes, created_at, updated_at FROM documents WHERE id = ? AND owner_id = ?",
    ).bind(id, ownerId).first<{ id: string; owner_id: string; title: string; object_key: string; revision: number; payload_bytes: number; created_at: string; updated_at: string }>();
    if (!row) return json({ error: "NOT_FOUND" }, 404, origin);

    if (request.method === "GET") {
      const object = await env.DOCS.get(row.object_key);
      if (!object) return json({ error: "DOCUMENT_DATA_MISSING" }, 500, origin);
      return new Response(object.body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(origin) },
      });
    }

    if (request.method === "PUT") {
      let body: { title?: unknown; content?: unknown; revision?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "INVALID_JSON" }, 400, origin); }
      if (!Number.isInteger(body.revision) || body.revision !== row.revision) {
        return json({ error: "REVISION_CONFLICT", revision: row.revision }, 409, origin);
      }
      let payload: { text: string; bytes: number };
      try { payload = parsePayload(body.content); } catch (error) {
        const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
        return json({ error: message }, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, origin);
      }

      const now = new Date().toISOString();
      const nextRevision = row.revision + 1;
      const nextObjectKey = "users/" + encodeURIComponent(ownerId) + "/documents/" + id + "/revision-" + nextRevision + ".json";
      try {
        await env.DOCS.put(nextObjectKey, payload.text, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
      } catch {
        return json({ error: "SAVE_FAILED" }, 500, origin);
      }
      const update = await env.DB.prepare(
        "UPDATE documents SET title = ?, object_key = ?, revision = ?, payload_bytes = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?",
      ).bind(normalizeTitle(body.title ?? row.title), nextObjectKey, nextRevision, payload.bytes, now, id, ownerId, row.revision).run();
      if (!update.success || update.meta.changes !== 1) {
        await env.DOCS.delete(nextObjectKey);
        return json({ error: "REVISION_CONFLICT" }, 409, origin);
      }
      await env.DOCS.delete(row.object_key);
      return json({ id, title: normalizeTitle(body.title ?? row.title), revision: nextRevision, updated_at: now }, 200, origin);
    }

    if (request.method === "DELETE") {
      const removed = await env.DB.prepare("DELETE FROM documents WHERE id = ? AND owner_id = ?")
        .bind(id, ownerId).run();
      if (!removed.success || removed.meta.changes !== 1) return json({ error: "DELETE_FAILED" }, 500, origin);
      await env.DOCS.delete(row.object_key);
      return json({ ok: true }, 200, origin);
    }
  }

  return json({ error: "NOT_FOUND" }, 404, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      const origin = getOrigin(request, env);
      return json({ error: "INTERNAL_ERROR" }, 500, origin);
    }
  },
};
