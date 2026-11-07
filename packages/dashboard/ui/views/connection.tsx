import type { EventsStatus, EventSummary, Fault, Subscription, WebhooksStatus } from "@kavishkagaya/connectd-runtime";
import { RefreshCw } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ActionInfo, DefinitionInfo, Detail, Overview } from "../../src/index.ts";
import { ApiError, api, method, seg } from "../api";
import { fields, safeUrl, time, trigger } from "../format";
import { Json, Loading, Mono, Note, PageTitle, Pairs, Problem, State, useAct, useLoad } from "../kit";

// ponytail: field types are guessed from names, as in the connect package's form.
const SECRET = /key|secret|token|password/i;

const Section = ({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) => (
  <Card>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
    <CardContent className="grid gap-4">{children}</CardContent>
  </Card>
);

const fault = (r: { error: Fault }) => new ApiError(r.error);

function EventsTable({ list, redeliver }: { list: EventSummary[]; redeliver?: (slot: number) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {["Slot", "Id", "Type", "At", "Data", "Delivery", ""].map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((e) => (
          <TableRow key={e.slot}>
            <TableCell>{e.slot}</TableCell>
            <TableCell className="font-mono text-xs">{e.id}</TableCell>
            <TableCell className="font-mono text-xs">{e.type}</TableCell>
            <TableCell className="text-xs">{time(e.at)}</TableCell>
            <TableCell className="max-w-64 truncate font-mono text-xs">{e.type.startsWith("webhook.") ? ((e.data as { topic?: string }).topic ?? "") : JSON.stringify(e.data)}</TableCell>
            <TableCell className="text-xs">
              {e.size} B{e.copy ? ", redelivered copy" : ""}
              {e.dropped ? ", dropped" : e.deliveredAt ? `, delivered ${time(e.deliveredAt)}` : ""}
            </TableCell>
            <TableCell>
              {redeliver && e.redeliverable ? (
                <Button size="sm" variant="outline" onClick={() => redeliver(e.slot)}>
                  Redeliver
                </Button>
              ) : redeliver ? (
                <span className="text-muted-foreground text-xs">body not kept</span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Run an action now, with its input from a form built from its JSON Schema, or a JSON text box. */
function RunForm({ def, id, a, done }: { def: string; id: string; a: ActionInfo; done: (n: ReactNode) => void }) {
  const list = a.input ? fields(a.schema) : [];
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [text, setText] = useState("");
  const act = useAct();
  const read = (): unknown => {
    if (!a.input) return null;
    if (list === null) {
      try {
        return text.trim() ? JSON.parse(text) : null;
      } catch {
        throw new Error("The input is not valid JSON.");
      }
    }
    return Object.fromEntries(
      list.flatMap((f): [string, string | number | boolean][] => {
        const v = values[f.name];
        if (f.kind === "boolean") return [[f.name, !!v]];
        if (v === undefined || v === "") return [];
        return [[f.name, f.kind === "number" || f.kind === "integer" ? Number(v) : (v as string)]];
      }),
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    act.run(async () => {
      const out = await method(def, id, `actions/${seg(a.id)}`, read());
      done(
        <>
          {a.id} returned: <Json value={out} />
        </>,
      );
    });
  };
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">Run {a.id}</summary>
      <form className="mt-3 grid gap-3" onSubmit={submit}>
        <Problem error={act.error} />
        {list === null ? (
          <div className="grid gap-1.5">
            <Label>Input (JSON)</Label>
            <Textarea aria-label={`${a.id} input (JSON)`} rows={4} placeholder="{}" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        ) : (
          list.map((f) => (
            <div key={f.name} className="grid gap-1.5">
              <Label htmlFor={`${a.id}-${f.name}`}>
                {f.name}
                {f.description ? <span className="text-muted-foreground font-normal"> {f.description}</span> : null}
              </Label>
              {f.kind === "boolean" ? (
                <Checkbox id={`${a.id}-${f.name}`} aria-label={f.name} checked={!!values[f.name]} onCheckedChange={(v) => setValues({ ...values, [f.name]: v === true })} />
              ) : f.kind === "enum" ? (
                <select id={`${a.id}-${f.name}`} aria-label={f.name} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={(values[f.name] as string) ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                  {f.required ? null : <option value="">—</option>}
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={`${a.id}-${f.name}`}
                  aria-label={f.name}
                  type={f.kind === "string" ? "text" : "number"}
                  step={f.kind === "integer" ? "1" : undefined}
                  required={f.required}
                  value={(values[f.name] as string) ?? ""}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </div>
          ))
        )}
        <Button type="submit" className="justify-self-start" disabled={act.busy}>
          Run {a.id} now
        </Button>
      </form>
    </details>
  );
}

/**
 * Start or re-authorize: API-key fields go to `connect`; an OAuth definition gets the provider's URL to open.
 * ponytail: that URL isn't bound to a browser (#28); a session-based connect (#29) needs this origin in `sessions.origins`.
 */
function Connect({ d, id, exists, done }: { d: DefinitionInfo; id: string; exists: boolean; done: (n: ReactNode) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const act = useAct();
  const title = exists ? "Re-authorize" : "Connect";
  if (!d.configured) return <Section title={title}>{`${d.id} has no connector config: it answers not_configured.`}</Section>;
  if (d.flow === "form")
    return (
      <Section title={title}>
        <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), act.run(async () => (await method(d.id, id, "connect", values), done("Connected."))))}>
          <Problem error={act.error} />
          {d.fields.map((f) => (
            <div key={f} className="grid gap-1.5">
              <Label htmlFor={`f-${f}`}>{f}</Label>
              <Input id={`f-${f}`} aria-label={f} type={SECRET.test(f) ? "password" : "text"} autoComplete="off" required value={values[f] ?? ""} onChange={(e) => setValues({ ...values, [f]: e.target.value })} />
            </div>
          ))}
          <Button type="submit" className="justify-self-start" disabled={act.busy}>
            {title}
          </Button>
        </form>
      </Section>
    );
  return (
    <Section title={title}>
      <Problem error={act.error} />
      <Button
        className="justify-self-start"
        variant="outline"
        disabled={act.busy}
        onClick={() =>
          act.run(async () => {
            const { url } = await method<{ url: string | null }>(d.id, id, "connect");
            done(
              !url ? (
                "Connected."
              ) : safeUrl(url) ? (
                <>
                  <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
                    Open the provider's authorization page
                  </a>{" "}
                  (new tab; it finishes at /callback, then refresh here).
                </>
              ) : (
                url
              ),
            );
          })
        }
      >
        Get an authorization link for {d.id}
      </Button>
    </Section>
  );
}

/** The latest kept `<action>.completed` / `.failed` of each action, from the connection's events. */
function lastRuns(d: DefinitionInfo, ev: EventsStatus | null) {
  const out = new Map<string, EventSummary>();
  if (!ev) return out;
  // Matched against the action names: a webhook topic can end in `.failed` too (`webhook.charge.failed`).
  const ids = new Set(d.actions.map((a) => a.id));
  for (const e of [...ev.queued, ...ev.recent]) {
    const m = /^(.+)\.(completed|failed)$/.exec(e.type);
    if (!m || e.copy || !ids.has(m[1] as string)) continue;
    const prev = out.get(m[1] as string);
    if (!prev || e.at > prev.at) out.set(m[1] as string, e);
  }
  return out;
}

export function Connection({ o, def, id }: { o: Overview; def: string; id: string }) {
  const d = o.definitions.find((x) => x.id === def);
  const x = useLoad(() => api<Detail>(`/dashboard/api/connections/${seg(def)}/${seg(id)}`), [def, id]);
  const act = useAct();
  const run = (f: () => Promise<ReactNode>) => act.run(async () => {
    const n = await f();
    x.reload();
    return n;
  });
  if (!d) return <Problem error={new Error(`No definition ${def} in this deployment.`)} />;
  if (x.error) return <Problem error={x.error} />;
  if (!x.data) return <Loading />;
  const v = x.data;
  const st = "ok" in v.status ? (v.status.ok as { state: string; reason?: string; metadata: unknown }) : null;
  const missing = "error" in v.status && v.status.error.code === "not_found";
  const ev = "ok" in v.events ? (v.events.ok as unknown as EventsStatus) : null;
  const last = lastRuns(d, ev);
  const next = new Map((v.actions && "ok" in v.actions ? (v.actions.ok as { id: string; next: number | null }[]) : []).map((a) => [a.id, a.next]));
  const done = (n: ReactNode) => (x.reload(), act.run(async () => n));

  return (
    <section className="grid gap-4">
      <PageTitle
        title={
          <>
            {def} / <Mono className="text-xl">{id}</Mono>
          </>
        }
      >
        {st && st.state !== "revoked" ? (
          <Button
            variant="outline"
            className="text-destructive"
            onClick={() => run(async () => (window.confirm(`Revoke ${def} / ${id}? This is terminal: reconnecting makes a new connection.`) ? (await method(def, id, "revoke", { reason: "dashboard" }), "Revoked.") : null))}
          >
            Revoke
          </Button>
        ) : null}
        {st && o.index ? (
          <Button variant="outline" onClick={() => run(async () => (await method(def, id, "index.sync"), "Index row re-copied."))}>
            Sync index
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => x.reload()}>
          <RefreshCw /> Refresh
        </Button>
      </PageTitle>
      <Problem error={act.error} />
      <Note>{act.note}</Note>

      <Section title="Status">
        {st ? (
          <>
            <Pairs
              rows={[
                ["State", <State key="s" state={st.state} />],
                ["Reason", st.reason ?? "—"],
                ["External ids", v.external ? Object.entries(v.external).map(([k, val]) => `${k}=${val}`).join(" ") || "—" : "—"],
              ]}
            />
            <Json value={st.metadata} />
          </>
        ) : missing ? (
          <p className="text-sm">No connection with this id yet.</p>
        ) : (
          <Problem error={fault(v.status as { error: Fault })} />
        )}
      </Section>

      {st?.state !== "revoked" ? <Connect d={d} id={id} exists={!!st} done={done} /> : null}

      {d.actions.length ? (
        <Section title="Actions">
          <Table>
            <TableHeader>
              <TableRow>
                {["Action", "Trigger", "Next run", "Last scheduled run"].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.actions.map((a) => {
                const e = last.get(a.id);
                const data = (e?.data ?? {}) as { error?: string; attempt?: number };
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Mono>{a.id}</Mono>
                    </TableCell>
                    <TableCell>{trigger(a)}</TableCell>
                    <TableCell>{a.every !== null ? time(next.get(a.id)) : "—"}</TableCell>
                    <TableCell>
                      {!e ? (a.every !== null || a.on !== null ? "none kept" : "—") : e.type.endsWith(".failed") ? <span className="text-warning">{`failed ${time(e.at)}: ${data.error ?? ""}${data.attempt ? ` (attempt ${data.attempt})` : ""}`}</span> : `ok ${time(e.at)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {v.actions && "error" in v.actions ? <Problem error={fault(v.actions)} /> : null}
          {d.actions.map((a) => (
            <RunForm key={a.id} def={def} id={id} a={a} done={done} />
          ))}
        </Section>
      ) : null}

      <Section title="Events">
        {!ev ? (
          <p className="text-sm">Not available ({"error" in v.events ? v.events.error.code : ""}): no events() extension?</p>
        ) : (
          <>
            {!ev.enabled ? <p className="text-muted-foreground text-sm">Event delivery is off (no events URL in the config).</p> : null}
            <Pairs
              rows={[
                ["Pending", String(ev.pending)],
                ["Attempt", String(ev.attempt)],
                ["Next retry", time(ev.retryAt)],
                ["Last error", ev.error ?? "—"],
              ]}
            />
            {ev.enabled && ev.pending ? (
              <Button className="justify-self-start" variant="outline" onClick={() => run(async () => (await method(def, id, "events.flush"), "Delivery started; refresh to see it."))}>
                Deliver now
              </Button>
            ) : null}
            {ev.queued.length ? (
              <>
                <h4 className="text-muted-foreground text-sm font-medium">Queued (head first)</h4>
                <EventsTable list={ev.queued} />
              </>
            ) : null}
            {ev.recent.length ? (
              <>
                <h4 className="text-muted-foreground text-sm font-medium">Recent (newest first)</h4>
                <EventsTable
                  list={ev.recent}
                  {...(ev.enabled ? { redeliver: (slot: number) => run(async () => `Queued again as slot ${(await method<{ slot: number }>(def, id, "events.redeliver", { slot })).slot}, same webhook-id.`) } : {})}
                />
              </>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Webhooks">
        {"error" in v.webhooks ? (
          <p className="text-sm">Not available ({v.webhooks.error.code}): no webhooks() extension?</p>
        ) : !(v.webhooks.ok as unknown as WebhooksStatus).supported ? (
          <p className="text-sm">This definition takes no webhooks.</p>
        ) : (
          (() => {
            const w = v.webhooks.ok as unknown as WebhooksStatus;
            return (
              <Pairs
                rows={[
                  ["Ingress URL", w.url ? <Mono key="u">{w.url}</Mono> : "— (no webhooks settings)"],
                  ["Auto-registers", w.registers ? "yes" : "no"],
                  ["Registration", w.registration ? <Json key="r" value={w.registration.hook} /> : "none"],
                  ["Renews at", time(w.registration?.renewAt)],
                  ["Registering", w.pending ? "armed or retrying" : "no"],
                ]}
              />
            );
          })()
        )}
        {v.subscriptions ? (
          <>
            <h4 className="text-muted-foreground text-sm font-medium">Subscriptions</h4>
            {"error" in v.subscriptions ? (
              <Problem error={fault(v.subscriptions)} />
            ) : !(v.subscriptions.ok as unknown as Subscription[]).length ? (
              <p className="text-sm">None. The app adds them with webhooks.subscribe().</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Id", "Input", "Renews at", ""].map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(v.subscriptions.ok as unknown as Subscription[]).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Mono>{s.id}</Mono>
                      </TableCell>
                      <TableCell>
                        <Json value={s.input} />
                      </TableCell>
                      <TableCell>{time(s.renewAt)}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => run(async () => (window.confirm(`Unsubscribe ${s.id}? It's removed at the provider too.`) ? (await method(def, id, "webhooks.unsubscribe", { id: s.id }), "Unsubscribed.") : null))}
                        >
                          Unsubscribe
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        ) : null}
      </Section>
    </section>
  );
}
