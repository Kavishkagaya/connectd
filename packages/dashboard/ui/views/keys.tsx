import type { KeyInfo } from "@kavishkagaya/connectd-runtime";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "../api";
import { time } from "../format";
import { Copyable, Loading, Mono, PageTitle, Problem, State, useAct, useLoad } from "../kit";

type Made = { key: string; info: KeyInfo };
const GRACE = [
  ["0", "Stop the old one now"],
  ["3600000", "1 hour"],
  ["86400000", "24 hours"],
  ["604800000", "7 days"],
] as const;

const envName = (k: KeyInfo) => (k.kind === "events" ? "CONNECTD_EVENTS_SECRET" : "CONNECTD_API_KEY");

/** A secret, once: it can't be read back. */
function Shown({ made, close, appUrl }: { made: Made | null; close: () => void; appUrl: string }) {
  return (
    <Dialog open={!!made} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{made?.info.kind === "events" ? "Events secret" : "API key"} {made?.info.name}</DialogTitle>
          <DialogDescription>Shown once: copy it into your app's environment now. It can't be read back; rolling it makes a new one.</DialogDescription>
        </DialogHeader>
        {made ? <Copyable value={`CONNECTD_URL=${appUrl}\n${envName(made.info)}=${made.key}`} label="Copy env" /> : null}
        <DialogFooter>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Keys() {
  const list = useLoad(() => api<KeyInfo[]>("/admin/keys"), []);
  const a = useAct();
  const [made, setMade] = useState<Made | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"api" | "events">("api");
  const [rolling, setRolling] = useState<KeyInfo | null>(null);
  const [grace, setGrace] = useState("0");
  const appUrl = window.location.origin;

  const create = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      setMade(await api<Made>("/admin/keys", "POST", { name: name.trim(), kind }));
      setName("");
      list.reload();
    });
  };
  const roll = () =>
    a.run(async () => {
      const k = rolling;
      setRolling(null);
      if (!k) return;
      setMade(await api<Made>(`/admin/keys/${k.id}/roll`, "POST", { graceMs: Number(grace) }));
      list.reload();
    });
  const revoke = (k: KeyInfo) =>
    a.run(async () => {
      if (!window.confirm(`Revoke ${k.name} (${k.prefix})? ${k.kind === "api" ? "Calls with it fail within 30 seconds." : "Events stop being signed with it."}`)) return;
      await api(`/admin/keys/${k.id}/revoke`, "POST", {});
      list.reload();
      return `Revoked ${k.name}.`;
    });

  const live = list.data?.filter((k) => k.status !== "revoked") ?? [];
  const revoked = list.data?.filter((k) => k.status === "revoked") ?? [];
  const rows = (keys: KeyInfo[], actions: boolean) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last used</TableHead>
          {actions ? <TableHead className="text-right" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((k) => (
          <TableRow key={k.id}>
            <TableCell className="font-medium">
              {k.name}
              <div className="text-muted-foreground text-xs">{k.kind === "events" ? "events secret" : "API key"}</div>
            </TableCell>
            <TableCell>
              <Mono>{k.prefix}</Mono>
            </TableCell>
            <TableCell>
              <State state={k.status} />
              {k.status === "rolling" ? <div className="text-muted-foreground text-xs">old one until {time(k.previousUntil)}</div> : null}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">{time(k.createdAt)}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{k.kind === "api" ? time(k.lastUsedAt) : "—"}</TableCell>
            {actions ? (
              <TableCell className="text-right whitespace-nowrap">
                <Button size="sm" variant="outline" onClick={() => (setGrace("0"), setRolling(k))} disabled={a.busy}>
                  <RotateCw /> Roll
                </Button>{" "}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(k)} disabled={a.busy} aria-label={`Revoke ${k.name}`}>
                  <Trash2 /> Revoke
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <section>
      <PageTitle title="Keys" description="API keys are how your app calls this deployment. Events secrets sign the events it sends your app; every live one signs, so rolling never drops a delivery." />
      <div className="grid gap-4">
        <Problem error={a.error ?? list.error} />
        {a.note ? <p className="text-success text-sm">{a.note}</p> : null}
        <Card>
          <CardHeader>
            <CardTitle>New key</CardTitle>
            <CardDescription>
              Or from the CLI: <Mono>connectd keys create &lt;name&gt;</Mono>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
              <div className="grid gap-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" name="name" required maxLength={64} placeholder="web, worker, ci…" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as "api" | "events")}>
                  <SelectTrigger className="w-44" aria-label="kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api">API key</SelectItem>
                    <SelectItem value="events">Events secret</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={a.busy}>
                <Plus /> Create
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardContent>{list.loading && !list.data ? <Loading /> : live.length ? rows(live, true) : <p className="text-muted-foreground text-sm">No live keys. Your app needs an API key to call this deployment.</p>}</CardContent>
        </Card>
        {revoked.length ? (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">Revoked ({revoked.length})</summary>
            <Card className="mt-2">
              <CardContent>{rows(revoked, false)}</CardContent>
            </Card>
          </details>
        ) : null}
      </div>
      <Shown made={made} close={() => setMade(null)} appUrl={appUrl} />
      <Dialog open={!!rolling} onOpenChange={(o) => !o && setRolling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roll {rolling?.name}</DialogTitle>
            <DialogDescription>A new secret for the same key. Keep the old one working while you update your app, or stop it now if it leaked.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>The old secret keeps working for</Label>
            <Select value={grace} onValueChange={setGrace}>
              <SelectTrigger aria-label="grace period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRACE.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRolling(null)}>
              Cancel
            </Button>
            <Button onClick={roll}>Roll</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
