// Where the Jev call goes. `JEV_BACKEND` picks one; both return the same shape
// ({ answers, usage }) so the rest of the Worker does not care which one ran.
//
//   typesafe-api  TypeSafe's own HTTP API with the owner's key (secret
//                 TYPESAFE_API_KEY). The default while Jev is not approved on
//                 Workers AI for the team.
//   workers-ai    Workers AI binding (`env.AI`). Switch to it later by setting
//                 JEV_BACKEND and JEV_MODEL; no code change.
import { buildJevInput, IMAGE_FORMATS, type Frame } from "./jev.ts";

export const DEFAULT_TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 45_000;

export type BackendName = "typesafe-api" | "workers-ai";

export interface JevEnv {
  AI?: {
    run(
      model: string,
      inputs: unknown,
      options?: { extraHeaders?: Record<string, string> },
    ): Promise<unknown>;
  };
  /** `typesafe-api` (default) or `workers-ai`. */
  JEV_BACKEND?: string;
  /** `jev-1.14.0` for typesafe-api; `typesafe/jev-1.14.0` for workers-ai. */
  JEV_MODEL: string;
  /** Secret. Never log it or put it in wrangler.toml. */
  TYPESAFE_API_KEY?: string;
  TYPESAFE_API_URL?: string;
  /** workers-ai only: "false" omits `TypeSafe-Danger-Zone-Images`. */
  JEV_IMAGE_HEADER?: string;
}

/** An error whose message is safe to show to the app (no keys, no images). */
export class BackendError extends Error {}

export function backendName(env: JevEnv): BackendName {
  const name = env.JEV_BACKEND?.trim() || "typesafe-api";
  if (name !== "typesafe-api" && name !== "workers-ai")
    throw new BackendError(`unknown JEV_BACKEND "${name}"`);
  return name;
}

export async function runJev(env: JevEnv, frame: Frame): Promise<unknown> {
  const name = backendName(env);
  if (name === "workers-ai") {
    if (!env.AI) throw new BackendError("AI binding is missing");
    const options =
      env.JEV_IMAGE_HEADER === "false"
        ? undefined
        : { extraHeaders: { "TypeSafe-Danger-Zone-Images": "true" } };
    return env.AI.run(
      env.JEV_MODEL,
      buildJevInput(frame, IMAGE_FORMATS["workers-ai"]),
      options,
    );
  }
  if (!env.TYPESAFE_API_KEY)
    throw new BackendError("TYPESAFE_API_KEY is not set");
  let response: Response;
  try {
    response = await fetch(env.TYPESAFE_API_URL || DEFAULT_TYPESAFE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "content-type": "application/json",
        "typesafe-danger-zone-images": "true",
      },
      body: JSON.stringify({
        model: env.JEV_MODEL,
        ...buildJevInput(frame, IMAGE_FORMATS["typesafe-api"]),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BackendError("TypeSafe API unreachable");
  }
  if (!response.ok)
    throw new BackendError(`TypeSafe API HTTP ${response.status}`);
  return response.json();
}
