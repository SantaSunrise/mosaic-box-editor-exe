// Verify the Cloudflare Access JWT in the Worker as well. Access already
// blocks unauthenticated requests, but the Worker must not trust a request
// that reached it some other way (for example a misconfigured route).
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

export type AccessClaims = {
  aud: string | string[];
  email?: string;
  exp: number;
  nbf?: number;
  iss: string;
  sub?: string;
};

type Jwk = JsonWebKey & { kid?: string };
type KeyCache = { keys: Map<string, CryptoKey>; fetchedAt: number };

const caches = new Map<string, KeyCache>();
const KEY_TTL_MS = 60 * 60 * 1000;

const decoder = new TextDecoder();
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function loadKeys(
  certsUrl: string,
  fetcher: typeof fetch,
): Promise<KeyCache> {
  const response = await fetcher(certsUrl);
  if (!response.ok) throw new Error(`certs ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  const cache = { keys, fetchedAt: Date.now() };
  caches.set(certsUrl, cache);
  return cache;
}

export async function verifyAccessJwt(
  token: string | null,
  options: {
    teamDomain: string;
    aud: string;
    now?: number;
    fetcher?: typeof fetch;
  },
): Promise<AccessClaims> {
  if (!token) throw new Error("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  const claims = JSON.parse(
    decoder.decode(base64UrlDecode(parts[1])),
  ) as AccessClaims;
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new Error("unsupported token");

  const issuer = `https://${options.teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const fetcher = options.fetcher ?? fetch;
  let cache = caches.get(certsUrl);
  // Keys rotate; refetch when stale or when the kid is unknown.
  if (
    !cache ||
    Date.now() - cache.fetchedAt > KEY_TTL_MS ||
    !cache.keys.has(header.kid)
  )
    cache = await loadKeys(certsUrl, fetcher);
  const key = cache.keys.get(header.kid);
  if (!key) throw new Error("unknown signing key");

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("bad signature");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.aud)) throw new Error("wrong audience");
  if (claims.iss !== issuer) throw new Error("wrong issuer");
  if (typeof claims.exp !== "number" || claims.exp <= now)
    throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60)
    throw new Error("not yet valid");
  return claims;
}

/** For tests: forget cached signing keys. */
export function clearKeyCache() {
  caches.clear();
}
