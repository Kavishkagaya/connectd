import type { Page, Row } from "@kavishkagaya/connectd-runtime";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Overview } from "../../src/index.ts";
import { api } from "../api";
import { time } from "../format";
import { hash, Loading, PageTitle, Problem, State } from "../kit";

const STATES = ["pending", "active", "reauth_required", "revoked"];
const ANY = "__any";

function Pick({ name, values, value, set }: { name: string; values: string[]; value: string; set: (v: string) => void }) {
  return (
    <Select value={value || ANY} onValueChange={(v) => set(v === ANY ? "" : v)}>
      <SelectTrigger className="w-44" aria-label={name}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>any {name}</SelectItem>
        {values.map((v) => (
          <SelectItem key={v} value={v}>
            {v}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Open (or start) a connection by definition and id. */
function OpenForm({ o }: { o: Overview }) {
  const [def, setDef] = useState(o.definitions[0]?.id ?? "");
  const [id, setId] = useState("");
  return (
    <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => (e.preventDefault(), def && id && (window.location.hash = hash("c", def, id)))}>
      <span className="text-muted-foreground">Open or start a connection:</span>
      <Pick name="definition" values={o.definitions.map((d) => d.id)} value={def} set={setDef} />
      <Input className="w-48" name="id" aria-label="connection id" placeholder="connection id" required value={id} onChange={(e) => setId(e.target.value)} />
      <Button type="submit" variant="outline">
        Open
      </Button>
    </form>
  );
}

export function Connections({ o, query }: { o: Overview; query: URLSearchParams }) {
  const [def, setDef] = useState(query.get("def") ?? "");
  const [state, setState] = useState(query.get("state") ?? "");
  const [q, setQ] = useState(query.get("q") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = query.toString();

  const page = async (from: string | null) => {
    const p = new URLSearchParams(query);
    if (from) p.set("cursor", from);
    const r = await api<Page>(`/connections?${p}`);
    setRows((prev) => [...(from ? (prev ?? []) : []), ...r.connections]);
    setCursor(r.cursor);
  };
  useEffect(() => {
    setRows(null);
    setError(null);
    if (o.index) page(null).catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, o.index]);

  const filter = (e: FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of [["def", def], ["state", state], ["q", q.trim()]] as const) if (v) p.set(k, v);
    window.location.hash = `#/?${p}`;
  };

  return (
    <section>
      <PageTitle title="Connections" />
      {!o.index ? (
        <div className="grid gap-4">
          <p className="text-sm">No connection index (directory) in this deployment: listing and search need it.</p>
          <OpenForm o={o} />
        </div>
      ) : (
        <div className="grid gap-4">
          <form className="flex flex-wrap gap-2" onSubmit={filter}>
            <Pick name="definition" values={o.definitions.map((d) => d.id)} value={def} set={setDef} />
            <Pick name="state" values={STATES} value={state} set={setState} />
            <Input className="w-56" type="search" name="q" aria-label="search" placeholder="id or external id" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>
          <Problem error={error} />
          <Card>
            <CardContent>
              {rows === null && !error ? (
                <Loading />
              ) : rows?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["Definition", "ID", "State", "Reason", "External ids", "Updated"].map((h) => (
                        <TableHead key={h}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((c) => (
                      <TableRow key={`${c.def}/${c.id}`}>
                        <TableCell>{c.def}</TableCell>
                        <TableCell>
                          <a className="text-primary font-medium underline-offset-4 hover:underline" href={hash("c", c.def, c.id)}>
                            {c.id}
                          </a>
                        </TableCell>
                        <TableCell>
                          <State state={c.state} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.reason ?? ""}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {Object.entries(c.external)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" ")}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{time(c.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : rows ? (
                <p className="text-muted-foreground text-sm">No connections.</p>
              ) : null}
              {cursor ? (
                <Button className="mt-4" variant="outline" onClick={() => page(cursor).catch(setError)}>
                  Load more
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <OpenForm o={o} />
        </div>
      )}
    </section>
  );
}
