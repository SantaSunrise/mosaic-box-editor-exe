import assert from "node:assert/strict";
import test from "node:test";
import { handle, MAX_FRAMES } from "../src/index.ts";
import { DEFAULT_TYPESAFE_URL } from "../src/backend.ts";

const claims = {
  aud: "a",
  iss: "i",
  exp: 2_000_000_000,
  email: "a@example.com",
};
const allow = async () => claims;
const deny = async () => {
  throw new Error("no");
};
function env(run) {
  const calls = [];
  return {
    calls,
    ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com",
    ACCESS_AUD: "a",
    JEV_BACKEND: "workers-ai",
    JEV_MODEL: "typesafe/jev-1.14.0",
    JEV_THRESHOLD: "0.5",
    AI: {
      run: async (...args) => {
        calls.push(args);
        return run(args[1]);
      },
    },
  };
}
const jev = (noul) => ({
  answers: {
    genitals_present: { type: "noul", noul },
    genitals_box: {
      type: "box",
      box: { top: 0.2, bottom: 0.4, left: 0.1, right: 0.3 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 700 },
});
const detectRequest = (frames, jwt = "jwt") =>
  new Request("https://check.example.com/v1/detect", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": jwt },
    body: JSON.stringify({ frames }),
  });

test("every route requires a verified Access token", async () => {
  for (const path of [
    "/v1/me",
    "/auth/desktop?port=5000&state=aaaaaaaaaaaaaaaa",
  ]) {
    const response = await handle(
      new Request("https://x.example.com" + path),
      env(),
      deny,
    );
    assert.equal(response.status, 401);
  }
});

test("desktop handoff redirects only to the loopback callback", async () => {
  const request = new Request(
    "https://x.example.com/auth/desktop?port=51234&state=abcdefghijklmnop",
    { headers: { "cf-access-jwt-assertion": "h.p.s" } },
  );
  const response = await handle(request, env(), allow);
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "http://127.0.0.1:51234/callback?state=abcdefghijklmnop&token=h.p.s",
  );
  for (const query of [
    "port=80&state=abcdefghijklmnop",
    "port=5000&state=short",
    "port=x&state=abcdefghijklmnop",
  ]) {
    const bad = await handle(
      new Request("https://x.example.com/auth/desktop?" + query, {
        headers: { "cf-access-jwt-assertion": "h.p.s" },
      }),
      env(),
      allow,
    );
    assert.equal(bad.status, 400);
  }
});

test("workers-ai backend runs Jev once per frame with the image header", async () => {
  const e = env((input) => jev(input.assets["img-frame-1"] ? 0.9 : 0.1));
  const response = await handle(
    detectRequest([
      { id: "0", mime: "image/jpeg", data: "AAAA" },
      { id: "1", mime: "image/png", data: "BBBB" },
    ]),
    e,
    allow,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(e.calls.length, 2);
  assert.equal(e.calls[0][0], "typesafe/jev-1.14.0");
  assert.deepEqual(e.calls[0][2], {
    extraHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
  });
  assert.equal(body.backend, "workers-ai");
  assert.deepEqual(body.frames[0], { id: "0", detections: [] });
  assert.deepEqual(body.frames[1].detections[0].box, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(body.frames[1].detections[0].located, true);
  assert.deepEqual(body.usage, { inputTokens: 1400 });
});

test("a failing frame is reported as an error, not as clean", async () => {
  const e = env(() => {
    throw new Error("400 bad request");
  });
  const body = await (
    await handle(
      detectRequest([{ id: "0", mime: "image/jpeg", data: "AAAA" }]),
      e,
      allow,
    )
  ).json();
  assert.deepEqual(body.frames[0], {
    id: "0",
    detections: [],
    error: "model error",
  });
});

test("detect validates frame count, type and base64", async () => {
  const frame = { id: "0", mime: "image/jpeg", data: "AAAA" };
  for (const frames of [
    [],
    Array(MAX_FRAMES + 1).fill(frame),
    [{ ...frame, mime: "image/gif" }],
    [{ ...frame, data: "not base64!" }],
    [{ ...frame, id: "../x" }],
  ]) {
    const response = await handle(
      detectRequest(frames),
      env(() => jev(0)),
      allow,
    );
    assert.equal(response.status, 400);
  }
});

function typesafeEnv(extra = {}) {
  return {
    ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com",
    ACCESS_AUD: "a",
    JEV_MODEL: "jev-1.14.0",
    JEV_THRESHOLD: "0.5",
    TYPESAFE_API_KEY: "test-key-not-real",
    ...extra,
  };
}
async function withFetch(impl, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    return { calls, result: await body() };
  } finally {
    globalThis.fetch = original;
  }
}
const frame0 = [{ id: "0", mime: "image/jpeg", data: "AAAA" }];

test("typesafe-api is the default backend and sends the key as a bearer token", async () => {
  const { calls, result } = await withFetch(
    async () => new Response(JSON.stringify(jev(0.9))),
    () => handle(detectRequest(frame0), typesafeEnv(), allow),
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.backend, "typesafe-api");
  assert.equal(body.frames[0].detections[0].score, 0.9);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_TYPESAFE_URL);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key-not-real");
  assert.equal(headers.get("typesafe-danger-zone-images"), "true");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "jev-1.14.0");
  assert.equal(sent.assets["img-frame-0"].format, "jpg");
  assert.equal(sent.assets["img-frame-0"].data_base64, "AAAA");
  // The key never appears in the response.
  assert.ok(!JSON.stringify(body).includes("test-key-not-real"));
});

test("a TypeSafe API failure is a per-frame error that names only the status", async () => {
  const { result } = await withFetch(
    async () => new Response("secret detail", { status: 429 }),
    () => handle(detectRequest(frame0), typesafeEnv(), allow),
  );
  const text = await result.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.frames[0], {
    id: "0",
    detections: [],
    error: "model error (TypeSafe API HTTP 429)",
  });
  assert.ok(!text.includes("secret detail"));
});

test("a missing key is an error, not a clean frame", async () => {
  const { calls, result } = await withFetch(
    async () => new Response("{}"),
    () =>
      handle(
        detectRequest(frame0),
        typesafeEnv({ TYPESAFE_API_KEY: "" }),
        allow,
      ),
  );
  const body = await result.json();
  assert.equal(calls.length, 0);
  assert.match(body.frames[0].error, /TYPESAFE_API_KEY is not set/);
  assert.deepEqual(body.frames[0].detections, []);
});

test("an unknown backend is rejected with 500", async () => {
  const response = await handle(
    detectRequest(frame0),
    typesafeEnv({ JEV_BACKEND: "nope" }),
    allow,
  );
  assert.equal(response.status, 500);
});

test("a malformed TypeSafe answer is an error, not a clean frame", async () => {
  const { result } = await withFetch(
    async () => new Response(JSON.stringify({ answers: {} })),
    () => handle(detectRequest(frame0), typesafeEnv(), allow),
  );
  const body = await result.json();
  assert.equal(body.frames[0].error, "model error");
  assert.deepEqual(body.frames[0].detections, []);
});
