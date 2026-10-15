// Stores the site's settings and character alerts in Cloudflare KV.
// Every request must carry a valid Cloudflare Access token, so the data stays
// private even if Access were misconfigured. Needs these Pages settings:
//   KV binding TRACKER_KV, env vars ACCESS_TEAM_DOMAIN (xyz.cloudflareaccess.com)
//   and ACCESS_AUD (the Access application's audience tag). Optional DEFAULT_WORLD
//   is the world shown until one is saved, so it never appears in this public repo.

const KEYS = new Set(["settings", "alerts"]);
const MAX_BODY = 64 * 1024;

let certs = { at: 0, keys: [] };

function b64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function accessKeys(teamDomain) {
  if (Date.now() - certs.at < 3600_000 && certs.keys.length) return certs.keys;
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  const { keys } = await resp.json();
  certs = { at: Date.now(), keys };
  return keys;
}

async function validAccessToken(token, env) {
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const [head, body, sig] = token.split(".");
  if (!sig) return false;
  const header = JSON.parse(new TextDecoder().decode(b64url(head)));
  const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${head}.${body}`));
  if (!ok) return false;
  const claims = JSON.parse(new TextDecoder().decode(b64url(body)));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return aud.includes(env.ACCESS_AUD) && claims.exp * 1000 > Date.now()
    && claims.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
}

export async function onRequest({ request, env, params }) {
  if (!KEYS.has(params.key)) return new Response("Not found", { status: 404 });
  let authorized = false;
  try {
    authorized = await validAccessToken(request.headers.get("Cf-Access-Jwt-Assertion"), env);
  } catch {
    authorized = false;
  }
  if (!authorized) return new Response("Unauthorized", { status: 401 });

  if (request.method === "GET") {
    let value = await env.TRACKER_KV.get(params.key);
    if (value === null && params.key === "settings" && env.DEFAULT_WORLD) {
      value = JSON.stringify({ world: env.DEFAULT_WORLD });
    }
    return new Response(value ?? "null", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
    try {
      JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    await env.TRACKER_KV.put(params.key, body);
    return new Response(null, { status: 204 });
  }
  return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT" } });
}
