import { expect, test } from "bun:test";
import { base64url, type Json } from "@connectd/kernel";
import {
  authorizeUrl,
  clientCredentials,
  deviceAuthorize,
  devicePoll,
  exchangeCode,
  OAuthError,
  pkce,
  register,
  revoke,
} from "./oauth.ts";

/** Fake fetch: records requests, replies with the next canned [status, body]. */
function fake(...replies: [number, Json][]) {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const [status, body] = replies.shift()!;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test("oauth: pkce challenge is S256 of the verifier", async () => {
  const { verifier, challenge } = await pkce();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  expect(challenge).toBe(base64url(new Uint8Array(digest)));
});

test("oauth: authorize url and code exchange (post and basic auth)", async () => {
  const client = { clientId: "id", clientSecret: "s", redirectUri: "https://x/cb" };
  const url = new URL(authorizeUrl("https://p/auth?x=1", client, { state: "st", scope: "a b" }));
  expect(Object.fromEntries(url.searchParams)).toEqual({ x: "1", client_id: "id", response_type: "code", redirect_uri: "https://x/cb", state: "st", scope: "a b" });

  const { f, seen } = fake([200, { access_token: "a" }], [200, { access_token: "b" }]);
  expect((await exchangeCode(f, "https://p/token", client, "c", "v")).access_token).toBe("a");
  expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
    grant_type: "authorization_code", code: "c", redirect_uri: "https://x/cb", code_verifier: "v", client_id: "id", client_secret: "s",
  });
  await exchangeCode(f, "https://p/token", { ...client, auth: "basic" }, "c");
  expect(seen[1]!.headers.authorization).toBe(`Basic ${btoa("id:s")}`);
  expect(seen[1]!.body).not.toContain("client_secret");
});

test("oauth: errors, including GitHub's 200-with-error", async () => {
  const { f } = fake([200, { error: "bad_verification_code" }], [400, { error: "invalid_grant" }], [500, "nope"]);
  const c = { clientId: "id" };
  await expect(exchangeCode(f, "u", c, "x")).rejects.toMatchObject({ code: "bad_verification_code", status: 200 });
  await expect(exchangeCode(f, "u", c, "x")).rejects.toMatchObject({ code: "invalid_grant", status: 400 });
  await expect(clientCredentials(f, "u", c)).rejects.toBeInstanceOf(OAuthError);
});

test("oauth: device flow, DCR, revoke", async () => {
  const { f, seen } = fake(
    [200, { device_code: "dc", user_code: "U", verification_uri: "https://p/d", expires_in: 600 }],
    [400, { error: "authorization_pending" }],
    [200, { access_token: "a" }],
    [201, { client_id: "new", client_secret: "sec" }],
    [200, {}],
  );
  const c = { clientId: "id" };
  expect((await deviceAuthorize(f, "u", c, "repo")).user_code).toBe("U");
  await expect(devicePoll(f, "u", c, "dc")).rejects.toMatchObject({ code: "authorization_pending" });
  expect((await devicePoll(f, "u", c, "dc")).access_token).toBe("a");
  expect((await register(f, "u", { redirect_uris: ["https://x/cb"] })).client_id).toBe("new");
  expect(JSON.parse(seen[3]!.body)).toEqual({ redirect_uris: ["https://x/cb"] });
  await revoke(f, "u", c, "tok", "refresh_token");
  expect(new URLSearchParams(seen[4]!.body).get("token_type_hint")).toBe("refresh_token");
});
