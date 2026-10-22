// Mosaic check API for Mosaic Box Editor. Deploy behind a Cloudflare Access
// self-hosted application; this Worker also verifies the Access JWT itself.
//
//   GET  /auth/desktop?port=&state=  hand the Access token to the app's loopback listener
//   GET  /v1/me                      who is logged in
//   POST /v1/detect                  find unmosaicked regions in frames
//
// No cron triggers, no storage: images are only forwarded to Workers AI.
import { verifyAccessJwt, type AccessClaims } from "./access.ts";
import {
  buildJevInput,
  inputTokens,
  isSupportedMime,
  parseJevAnswers,
  type Detection,
  type Frame,
} from "./jev.ts";

export interface Env {
  AI: {
    run(
      model: string,
      inputs: unknown,
      options?: { extraHeaders?: Record<string, string> },
    ): Promise<unknown>;
  };
  /** e.g. `your-team.cloudflareaccess.com` */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD: string;
  JEV_MODEL: string;
  /** Minimum yes probability that counts as a detection. */
  JEV_THRESHOLD?: string;
  /** "true" sends `TypeSafe-Danger-Zone-Images: true` with each run. */
  JEV_IMAGE_HEADER?: string;
}

export const MAX_FRAMES = 10;
// 1024px JPEGs are ~100–400 KB; 4M base64 characters leave room for PNG.
export const MAX_BASE64_LENGTH = 4_000_000;

type Verify = (request: Request, env: Env) => Promise<AccessClaims>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const defaultVerify: Verify = (request, env) =>
  verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });

function desktopHandoff(request: Request, url: URL): Response {
  const port = Number(url.searchParams.get("port"));
  const state = url.searchParams.get("state") ?? "";
  // Only this machine's loopback, only on an unprivileged port, and only with
  // a state value shaped like the one the app generates.
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state)
  )
    return json({ error: "invalid port or state" }, 400);
  const token = request.headers.get("cf-access-jwt-assertion")!;
  const target = new URL(`http://127.0.0.1:${port}/callback`);
  target.searchParams.set("state", state);
  target.searchParams.set("token", token);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function parseFrames(body: unknown): Frame[] {
  const frames = (body as { frames?: unknown })?.frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES)
    throw new Error(`frames must contain 1-${MAX_FRAMES} items`);
  return frames.map((frame) => {
    const { id, mime, data } = frame ?? {};
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,16}$/.test(id) ||
      typeof mime !== "string" ||
      !isSupportedMime(mime) ||
      typeof data !== "string" ||
      data.length === 0 ||
      data.length > MAX_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      throw new Error("invalid frame");
    return { id, mime, data };
  });
}

async function detect(request: Request, env: Env): Promise<Response> {
  let frames: Frame[];
  try {
    frames = parseFrames(await request.json());
  } catch (error) {
    return json({ error: String((error as Error).message ?? error) }, 400);
  }
  const threshold = Number(env.JEV_THRESHOLD ?? "0.5");
  const options =
    env.JEV_IMAGE_HEADER === "false"
      ? undefined
      : { extraHeaders: { "TypeSafe-Danger-Zone-Images": "true" } };
  let tokens = 0;
  const results: { id: string; detections: Detection[]; error?: string }[] = [];
  for (const frame of frames) {
    try {
      const output = await env.AI.run(
        env.JEV_MODEL,
        buildJevInput(frame),
        options,
      );
      tokens += inputTokens(output);
      results.push({
        id: frame.id,
        detections: parseJevAnswers(output, threshold),
      });
    } catch (error) {
      // Never echo the image back; the message is enough to debug.
      console.error("jev run failed", { id: frame.id, error: String(error) });
      results.push({ id: frame.id, detections: [], error: "model error" });
    }
  }
  return json({
    model: env.JEV_MODEL,
    frames: results,
    usage: { inputTokens: tokens },
  });
}

export async function handle(
  request: Request,
  env: Env,
  verify: Verify = defaultVerify,
): Promise<Response> {
  const url = new URL(request.url);
  let claims: AccessClaims;
  try {
    claims = await verify(request, env);
  } catch {
    return json({ error: "unauthorized" }, 401);
  }
  if (request.method === "GET" && url.pathname === "/auth/desktop")
    return desktopHandoff(request, url);
  if (request.method === "GET" && url.pathname === "/v1/me")
    return json({ email: claims.email ?? null, exp: claims.exp });
  if (request.method === "POST" && url.pathname === "/v1/detect")
    return detect(request, env);
  return json({ error: "not found" }, 404);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
