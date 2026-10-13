import { expect, test } from "bun:test";
import { toNode } from "./node.ts";

/** A Node-shaped request (async iterable of chunks) and a response that records what was written. */
function node(o: { body?: unknown; chunks?: string[]; host?: string } = {}) {
  const enc = new TextEncoder();
  const req = {
    method: "POST",
    url: "/events?x=1",
    headers: { host: o.host ?? "app.test", "content-type": "application/json", "x-multi": ["a", "b"] } as Record<string, string | string[] | undefined>,
    ...(o.body === undefined ? {} : { body: o.body }),
    async *[Symbol.asyncIterator]() {
      for (const c of o.chunks ?? []) yield enc.encode(c);
    },
  };
  const res = { statusCode: 0, headers: {} as Record<string, string>, sent: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: Uint8Array) { this.sent = b ? new TextDecoder().decode(b) : ""; } };
  return { req, res };
}

const echo = async (req: Request) => Response.json({ url: req.url, multi: req.headers.get("x-multi"), body: await req.text() }, { status: 201, headers: { "x-out": "1" } });

test("streams the raw body into a Request and writes the Response back", async () => {
  const { req, res } = node({ chunks: ['{"a":', "1}"] });
  await toNode(echo)(req, res);
  expect(res.statusCode).toBe(201);
  expect(res.headers["x-out"]).toBe("1");
  expect(JSON.parse(res.sent)).toEqual({ url: "http://localhost/events?x=1", multi: "a, b", body: '{"a":1}' });
});

test("takes a raw body from express.raw(); refuses one a JSON parser already consumed", async () => {
  const raw = node({ body: new TextEncoder().encode("raw!") });
  await toNode(echo)(raw.req, raw.res);
  expect(JSON.parse(raw.res.sent).body).toBe("raw!");

  // Express with only an unrelated parser leaves `{}` and the stream unread.
  const empty = node({ body: {}, chunks: ["streamed"] });
  await toNode(echo)(empty.req, empty.res);
  expect(JSON.parse(empty.res.sent).body).toBe("streamed");

  const parsed = node({ body: { a: 1 } });
  const err = console.error;
  console.error = () => {};
  await toNode(echo)(parsed.req, parsed.res);
  console.error = err;
  expect(parsed.res.statusCode).toBe(500);
});

test("a malformed Host or a throwing handler answers 500 instead of crashing the process", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    const bad = node({ host: "a b", chunks: ["x"] });
    await toNode(echo)(bad.req, bad.res);
    expect(JSON.parse(bad.res.sent).url).toBe("http://localhost/events?x=1"); // Host is never used

    const odd = node({ chunks: ["x"] });
    odd.req.url = "//a b/";
    await toNode(echo)(odd.req, odd.res);
    expect(odd.res.statusCode).toBe(500);

    const boom = node({ chunks: ["x"] });
    await toNode(async () => {
      throw new Error("boom");
    })(boom.req, boom.res);
    expect(boom.res.statusCode).toBe(500);
  } finally {
    console.error = err;
  }
});
