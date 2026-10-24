/**
 * `(Request) => Response` handlers on Node's `http` server and Express, which speak (req, res)
 * instead. Typed structurally, so no Node types or imports: this file runs anywhere, it's only
 * useful on Node.
 *
 *   app.post("/connectd/events", toNode(ev.handle)); // before express.json(), or after express.raw()
 */

type NodeRequest = AsyncIterable<Uint8Array> & {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Set by Express body parsers. Raw (`express.raw()`, a Buffer) is fine; parsed JSON isn't. */
  body?: unknown;
};
type NodeResponse = { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: Uint8Array): unknown };

export function toNode(handle: (req: Request) => Promise<Response>) {
  const run = async (req: NodeRequest, res: NodeResponse) => {
    // Casts: Node's Buffer is a Uint8Array over ArrayBufferLike, which the DOM types don't take as a body.
    let body: RequestInit["body"];
    if (typeof req.body === "string" || req.body instanceof Uint8Array) body = req.body as RequestInit["body"];
    else if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
      // A JSON parser already ran: the raw bytes the signature covers are gone. Not a 2xx, so the event waits for the fix.
      console.error("connectd: the body was already parsed; mount this before express.json() or use express.raw()");
      res.statusCode = 500;
      return void res.end();
    } else {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c);
      body = await new Blob(chunks as unknown as ConstructorParameters<typeof Blob>[0]).arrayBuffer();
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const method = req.method ?? "GET";
    const out = await handle(
      // A fixed origin: the Host header is the client's to write, and a malformed one makes the URL throw.
      new Request(new URL(req.url ?? "/", "http://localhost").href, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) }),
    );
    res.statusCode = out.status;
    out.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(new Uint8Array(await out.arrayBuffer()));
  };
  // Nothing may escape: Express 4 and node:http don't catch a rejected handler, and an unhandled rejection kills the process.
  return async (req: NodeRequest, res: NodeResponse) => {
    try {
      await run(req, res);
    } catch (e) {
      console.error("connectd: node adapter", e);
      res.statusCode = 500;
      res.end();
    }
  };
}
