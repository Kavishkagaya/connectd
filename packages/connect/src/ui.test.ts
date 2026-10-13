import { expect, test } from "bun:test";
import { APP, type El, OC, setup } from "./fake.ts";
import { connect, type Result } from "./connect.ts";
import { mount } from "./ui.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test("button for redirect flows: a click opens the popup at once and reports the result", async () => {
  const t = await setup();
  const el = t.win.document.createElement("div");
  const results: Result[] = [];
  mount(el as unknown as HTMLElement, { url: OC, token: await t.token("example", "u1"), window: t.win as unknown as Window, onResult: (r) => results.push(r) });
  await settle();
  const [button] = el.all("button") as [El];
  expect(button.textContent).toBe("Connect example");
  button.dispatch("click");
  expect(t.win.opened).toHaveLength(1); // synchronously, inside the click
  expect(button.disabled).toBe(true);
  await settle();
  await t.finish();
  await settle();
  expect(results).toEqual([{ status: "connected" }]);
  expect(button.disabled).toBe(false);
  expect(el.all("p")[0]!.textContent).toBe("Connected.");
});

test("form for API-key flows: one input per field, submitted through the session", async () => {
  const t = await setup();
  const el = t.win.document.createElement("div");
  const results: Result[] = [];
  const unmount = mount(el as unknown as HTMLElement, { url: OC, token: () => t.token("keyed", "k1"), window: t.win as unknown as Window, onResult: (r) => results.push(r) });
  await settle();
  const inputs = el.all("input");
  expect(inputs.map((i) => [i.name, i.type, i.required])).toEqual([
    ["apiKey", "password", true],
    ["region", "text", true],
  ]);
  inputs[0]!.value = "sk";
  inputs[1]!.value = "eu";
  el.all("form")[0]!.dispatch("submit");
  await settle();
  expect(results).toEqual([{ status: "connected" }]);
  expect(await t.status("keyed", "k1")).toBe("active");
  expect(t.win.opened).toHaveLength(0);
  unmount();
  expect(el.children).toHaveLength(0);
});

test("a refused token shows the error", async () => {
  const t = await setup();
  const el = t.win.document.createElement("div");
  const results: Result[] = [];
  mount(el as unknown as HTMLElement, { url: OC, token: "forged", window: t.win as unknown as Window, onResult: (r) => results.push(r) });
  await settle();
  expect(results).toMatchObject([{ status: "error", code: "unauthorized" }]);
  expect(el.all("p")[0]!.textContent).toBe("Could not connect (unauthorized).");
});

test("two mounts on the return page, then a reload: the outcome goes to its own mount, once", async () => {
  const t = await setup();
  const gh = await t.token("example", "u1", { returnUrl: `${APP}/back` });
  await connect({ url: OC, token: gh, mode: "redirect", window: t.win as unknown as Window });
  t.win.location.href = (await t.finish()).location!;

  const page = () => {
    const seen: Record<string, Result[]> = { gh: [], keyed: [] };
    const a = t.win.document.createElement("div");
    const b = t.win.document.createElement("div");
    mount(a as unknown as HTMLElement, { url: OC, token: gh, window: t.win as unknown as Window, onResult: (r) => seen.gh!.push(r) });
    mount(b as unknown as HTMLElement, { url: OC, token: () => t.token("keyed", "k1"), window: t.win as unknown as Window, onResult: (r) => seen.keyed!.push(r) });
    return seen;
  };
  const first = page();
  await settle();
  expect(first).toEqual({ gh: [{ status: "connected" }], keyed: [] });
  expect(t.win.location.href).toBe(`${APP}/back`);
  const reload = page();
  await settle();
  expect(reload).toEqual({ gh: [], keyed: [] });
});
