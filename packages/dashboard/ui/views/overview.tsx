import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DefinitionInfo, Failures, Overview } from "../../src/index.ts";
import { api } from "../api";
import { time, trigger } from "../format";
import { hash, Loading, Mono, PageTitle, Pairs, Problem, useLoad } from "../kit";

const ANY = "__any";

/** Every action of the deployment, and recent failed scheduled runs across connections. */
export function Actions({ o, query }: { o: Overview; query: URLSearchParams }) {
  const all = o.definitions.flatMap((d) => d.actions.map((a) => ({ def: d.id, a })));
  const current = query.get("def") ?? "";
  const [pick, setPick] = useState(current);
  const f = useLoad(() => (o.index && all.length ? api<Failures>(`/dashboard/api/failures${current ? `?def=${encodeURIComponent(current)}` : ""}`) : Promise.resolve(null)), [current, o.index]);
  if (!all.length)
    return (
      <section>
        <PageTitle title="Actions" />
        <p className="text-sm">No actions in this deployment. Add them in src/oc/&lt;connection&gt;/actions.ts.</p>
      </section>
    );
  const defs = [...new Set(all.map((x) => x.def))];
  return (
    <section className="grid gap-4">
      <PageTitle title="Actions" />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                {["Connection", "Action", "Trigger", "Input"].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {all.map(({ def, a }) => (
                <TableRow key={`${def}.${a.id}`}>
                  <TableCell>{def}</TableCell>
                  <TableCell>
                    <Mono>{a.id}</Mono>
                  </TableCell>
                  <TableCell>{trigger(a)}</TableCell>
                  <TableCell>{a.input ? (a.schema ? "schema" : "yes") : "none"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Recent failures</CardTitle>
          {o.index ? (
            <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), (window.location.hash = pick ? `#/actions?def=${encodeURIComponent(pick)}` : "#/actions"))}>
              <Select value={pick || ANY} onValueChange={(v) => setPick(v === ANY ? "" : v)}>
                <SelectTrigger className="w-44" aria-label="definition">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>any definition</SelectItem>
                  {defs.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" variant="outline">
                Filter
              </Button>
            </form>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3">
          {!o.index ? (
            <p className="text-sm">Needs a connection index (directory) to look across connections.</p>
          ) : f.error ? (
            <Problem error={f.error} />
          ) : !f.data ? (
            <Loading />
          ) : (
            <>
              {f.data.failures.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["At", "Connection", "Action", "Error", "Attempt"].map((h) => (
                        <TableHead key={h}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {f.data.failures.map((x) => (
                      <TableRow key={`${x.def}/${x.id}/${x.action}/${x.at}`}>
                        <TableCell className="text-xs">{time(x.at)}</TableCell>
                        <TableCell>
                          {x.def} /{" "}
                          <a className="underline-offset-4 hover:underline" href={hash("c", x.def, x.id)}>
                            {x.id}
                          </a>
                        </TableCell>
                        <TableCell>
                          <Mono>{x.action}</Mono>
                        </TableCell>
                        <TableCell>{x.error}</TableCell>
                        <TableCell>{x.attempt}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm">No failed runs in the kept events.</p>
              )}
              <p className="text-muted-foreground text-xs">
                Looked at {f.data.scanned} connection{f.data.scanned === 1 ? "" : "s"}
                {f.data.more ? " (the first ones in the index; filter by definition to narrow it)" : ""}, from each one's kept events.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

const config = (d: DefinitionInfo) => (!d.configured ? "missing: not_configured" : d.missing.length ? `empty: ${d.missing.join(", ")}` : d.flow === "form" ? "not needed" : "set");

export function Definitions({ o }: { o: Overview }) {
  return (
    <section className="grid gap-4">
      <PageTitle title="Deployment" description="Register the callback URL as the redirect URI with each OAuth provider." />
      <Card>
        <CardContent>
          <Pairs
            rows={[
              ["Callback URL", <Mono key="c">{o.callbackUrl}</Mono>],
              ["Webhooks", o.webhooks ? <Mono key="w">{`${o.webhooks.url}/:def[/:id]`}</Mono> : "off"],
              ["Events", o.events ? <Mono key="e">{o.events.url}</Mono> : "off"],
              ["Sessions", o.sessions ? o.sessions.origins.join(", ") || "no origins" : "off"],
              ["Index", o.index ? "on" : "off"],
              ["Version", <Mono key="v">{o.version}</Mono>],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Definitions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                {["Id", "Flow", "Config", "Proxy", "Webhook URLs"].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.definitions.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a className="font-medium underline-offset-4 hover:underline" href={`#/?def=${encodeURIComponent(d.id)}`}>
                      {d.id}
                    </a>
                  </TableCell>
                  <TableCell>{d.flow === "form" ? `form (${d.fields.join(", ")})` : "redirect"}</TableCell>
                  <TableCell className={d.configured && !d.missing.length ? "" : "text-warning"}>{config(d)}</TableCell>
                  <TableCell>{d.proxy ? <Mono>{d.proxy}</Mono> : "—"}</TableCell>
                  <TableCell>
                    {d.webhooks ? (
                      <div className="grid gap-1">
                        <Mono>{d.webhooks.app}</Mono>
                        <Mono>{d.webhooks.connection}</Mono>
                        {d.webhooks.registers ? <span className="text-muted-foreground text-xs">registered per connection</span> : null}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
