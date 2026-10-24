"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser, oc, USER_COOKIE } from "../lib/oc";

export async function signIn(form: FormData) {
  // No ":" in user ids: it separates a user from their other accounts.
  const name = String(form.get("name") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  if (name) (await cookies()).set(USER_COOKIE, name, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}

export async function signOut() {
  (await cookies()).delete(USER_COOKIE);
  redirect("/");
}

export async function disconnect() {
  const user = await currentUser();
  if (user) await oc.connection("github", user).revoke();
  redirect("/");
}
