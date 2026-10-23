import { expect, test } from "bun:test";
import { sign } from "../primitives/secrets.ts";
import { routeTicket } from "./ticket.ts";
import { world } from "./testkit.ts";

const setup = async () =>
  world((k) => ({
    login: k.ticket<{ verifier: string }>("login", { ttlMs: 600_000 }),
    session: k.ticket<{ verifier: string }>("session", { ttlMs: 600_000 }),
  }));

test("ticket: the data comes back once, for the instance and ticket that issued it", async () => {
  const { get, opts } = await setup();
  const a = await get("conn:github:a");
  const t = await a.login.issue({ verifier: "v1" });
  expect(t).not.toContain("v1"); // only a reference travels
  expect(await routeTicket(t, opts.stateKey)).toMatchObject({ instance: "conn:github:a", name: "login" });
  expect(await a.session.redeem(t)).toBeNull(); // another ticket's
  expect(await (await get("conn:github:b")).login.redeem(t)).toBeNull(); // another instance's
  expect(await a.login.redeem(t)).toEqual({ verifier: "v1" });
  expect(await a.login.redeem(t)).toBeNull(); // used
});

test("ticket: forged, malformed and expired ones are null", async () => {
  const { get, opts, w } = await setup();
  const a = await get("conn:github:a");
  const t = await a.login.issue({ verifier: "v1" });
  const [payload] = t.split(".");
  expect(await a.login.redeem(`${payload}.AAAA`)).toBeNull();
  expect(await a.login.redeem("garbage")).toBeNull();
  expect(await routeTicket(await sign("not json", opts.stateKey), opts.stateKey)).toBeNull();
  expect(await routeTicket(await sign(JSON.stringify(["only", "two"]), opts.stateKey), opts.stateKey)).toBeNull();
  await w.advance(600_000);
  expect(await a.login.redeem(t)).toBeNull();
});
