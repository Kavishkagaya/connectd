import { connectd } from "@kavishkagaya/connectd-sdk";
import { cookies } from "next/headers";
import { listeners } from "../../.connectd/app";

/** The demo's "signed-in user": a name in a cookie. Use your auth's user id instead. */
export const USER_COOKIE = "demo_user";
export async function currentUser() {
  return (await cookies()).get(USER_COOKIE)?.value ?? null;
}

// CONNECTD_URL, CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET from the environment (see the README);
// in production, the values `connectd deploy` prints.
export const oc = connectd({
  user: (req) => req.headers.get("cookie")?.match(/(?:^|;\s*)demo_user=([^;]+)/)?.[1] ?? null,
  listeners,
  ...(process.env.APP_URL ? { origin: process.env.APP_URL } : {}),
});
