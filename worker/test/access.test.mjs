import assert from "node:assert/strict";
import test from "node:test";
import { clearKeyCache, verifyAccessJwt } from "../src/access.ts";

const team = "example-team.cloudflareaccess.com";
const aud = "test-aud";
const encode = (value) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");

const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "k1",
};
let certRequests = 0;
const fetcher = async (url) => {
  certRequests++;
  assert.equal(url, `https://${team}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};

async function sign(claims, kid = "k1") {
  const head = encode({ alg: "RS256", kid });
  const body = encode(claims);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}
const now = 1_900_000_000;
const valid = {
  aud: [aud],
  iss: `https://${team}`,
  exp: now + 3600,
  email: "a@example.com",
};
const options = { teamDomain: team, aud, now, fetcher };

test("accepts a token signed by the team key for this application", async () => {
  clearKeyCache();
  const claims = await verifyAccessJwt(await sign(valid), options);
  assert.equal(claims.email, "a@example.com");
  await verifyAccessJwt(await sign(valid), options);
  assert.equal(certRequests, 1, "keys are cached");
});

test("rejects wrong audience, issuer, expiry and tampering", async () => {
  for (const claims of [
    { ...valid, aud: ["other"] },
    { ...valid, iss: "https://evil.cloudflareaccess.com" },
    { ...valid, exp: now - 1 },
  ])
    await assert.rejects(verifyAccessJwt(await sign(claims), options));
  const token = await sign(valid);
  const [h, , s] = token.split(".");
  await assert.rejects(
    verifyAccessJwt(
      `${h}.${encode({ ...valid, email: "b@example.com" })}.${s}`,
      options,
    ),
  );
  await assert.rejects(verifyAccessJwt(await sign(valid, "unknown"), options));
  await assert.rejects(verifyAccessJwt(null, options));
  await assert.rejects(verifyAccessJwt("a.b", options));
});
