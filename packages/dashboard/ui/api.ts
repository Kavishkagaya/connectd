import type { Fault } from "@kavishkagaya/connectd-runtime";

/** A refusal from the deployment: its error code and message. */
export class ApiError extends Error {
  constructor(readonly fault: Fault) {
    super(fault.message);
  }
}

/** Called when a request says the session is gone (expired, signed out elsewhere). */
let onSignedOut = () => {};
export const signedOut = (f: () => void) => void (onSignedOut = f);

/**
 * A same-origin JSON request. The session is an HttpOnly cookie the browser sends itself; nothing
 * secret is in this tab's storage or a URL.
 */
export async function api<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const b = (await res.json().catch(() => null)) as { error?: Fault } | null;
  if (!res.ok) {
    const f = b?.error ?? { code: "http_error", status: res.status, message: `HTTP ${res.status}` };
    if (res.status === 401 && !path.startsWith("/dashboard/api/auth/")) onSignedOut();
    throw new ApiError(f);
  }
  return b as T;
}

/** Usable as a path segment: not empty, `.` or `..` (URL parsing would collapse those into another route). */
export const addressable = (s: string) => s !== "" && s !== "." && s !== "..";
export const seg = (s: string) => {
  if (!addressable(s)) throw new Error(`Not a connection address: "${s}" (definition and id can't be empty, "." or "..").`);
  return encodeURIComponent(s);
};
/** A connection method: `POST /connections/:def/:id/:method`. */
export const method = <T = unknown,>(def: string, id: string, m: string, args: unknown = null) => api<T>(`/connections/${seg(def)}/${seg(id)}/${m}`, "POST", args);
