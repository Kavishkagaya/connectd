import { Fingerprint, Trash2, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountInfo, Me } from "../../src/index.ts";
import { api } from "../api";
import { time } from "../format";
import { Copyable, Loading, PageTitle, Problem, useAct, useLoad } from "../kit";
import * as passkey from "../passkey";

export function Accounts({ me, changed }: { me: Me; changed: () => void }) {
  const list = useLoad(() => api<AccountInfo[]>("/dashboard/api/auth/accounts"), []);
  const a = useAct();
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [password, setPassword] = useState("");
  const [keyName, setKeyName] = useState("");

  const after = () => (list.reload(), changed());
  const setPw = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await api("/dashboard/api/auth/me/password", "POST", { password });
      setPassword("");
      after();
      return "Password saved.";
    });
  };

  return (
    <section>
      <PageTitle title="Accounts" description="Who can sign in to this dashboard. Every account can manage keys, connections and other accounts." />
      <div className="grid gap-4">
        <Problem error={a.error ?? list.error} />
        {a.note ? <p className="text-success text-sm">{a.note}</p> : null}

        {me.user ? (
          <Card>
            <CardHeader>
              <CardTitle>You: {me.user}</CardTitle>
              <CardDescription>How you sign in. Keep at least one way: the dashboard won't remove your last one.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6">
              <div className="grid gap-3">
                <h3 className="text-sm font-medium">Passkeys</h3>
                {me.passkeys.length ? (
                  <ul className="grid gap-2">
                    {me.passkeys.map((k) => (
                      <li key={k.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                        <span>
                          <Fingerprint className="mr-2 inline size-4" />
                          {k.name} <span className="text-muted-foreground text-xs">added {time(k.createdAt)}, last used {time(k.lastUsedAt)}</span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Remove passkey ${k.name}`}
                          onClick={() => a.run(async () => (window.confirm(`Remove the passkey ${k.name}?`) ? (await api(`/dashboard/api/auth/me/passkeys/${encodeURIComponent(k.id)}/delete`, "POST", {}), after(), "Passkey removed.") : undefined))}
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">None yet.</p>
                )}
                {passkey.supported() ? (
                  <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), a.run(async () => (await passkey.register(keyName.trim() || "passkey"), setKeyName(""), after(), "Passkey added.")))}>
                    <div className="grid gap-1.5">
                      <Label htmlFor="passkey-name">Name</Label>
                      <Input id="passkey-name" placeholder="MacBook, phone…" value={keyName} onChange={(e) => setKeyName(e.target.value)} maxLength={64} />
                    </div>
                    <Button type="submit" variant="outline" disabled={a.busy}>
                      <Fingerprint /> Add a passkey
                    </Button>
                  </form>
                ) : (
                  <p className="text-muted-foreground text-xs">This browser can't make passkeys.</p>
                )}
              </div>
              <div className="grid gap-3">
                <h3 className="text-sm font-medium">Password {me.password ? <Badge variant="outline">set</Badge> : <Badge variant="outline">none</Badge>}</h3>
                <form className="flex flex-wrap items-end gap-2" onSubmit={setPw}>
                  <div className="grid gap-1.5">
                    <Label htmlFor="new-pw">{me.password ? "New password" : "Password"}</Label>
                    <Input id="new-pw" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <Button type="submit" variant="outline" disabled={a.busy}>
                    {me.password ? "Change" : "Set"} password
                  </Button>
                  {me.password ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      disabled={a.busy}
                      onClick={() => a.run(async () => (await api("/dashboard/api/auth/me/password", "POST", { password: null }), after(), "Password removed: passkeys only."))}
                    >
                      Remove password
                    </Button>
                  ) : null}
                </form>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Everyone</CardTitle>
              <CardDescription>An invite is a one-time link for 72 hours: whoever opens it picks a username.</CardDescription>
            </div>
            <Button variant="outline" disabled={a.busy} onClick={() => a.run(async () => void setInvite(await api("/dashboard/api/auth/invites", "POST", {})))}>
              <UserPlus /> Invite
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4">
            {invite ? (
              <div className="grid gap-2">
                <p className="text-sm">Send this link to who you're inviting (it works once, until {time(invite.expiresAt)}):</p>
                <Copyable value={invite.url} label="Copy link" />
              </div>
            ) : null}
            {list.loading && !list.data ? (
              <Loading />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Signs in with</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(list.data ?? []).map((u) => (
                    <TableRow key={u.username}>
                      <TableCell className="font-medium">
                        {u.username} {u.username === me.user ? <Badge variant="secondary">you</Badge> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{[u.passkeys ? `${u.passkeys} passkey${u.passkeys === 1 ? "" : "s"}` : "", u.password ? "password" : ""].filter(Boolean).join(", ") || "nothing yet"}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{time(u.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Delete ${u.username}`}
                          onClick={() =>
                            a.run(async () => {
                              if (!window.confirm(`Delete ${u.username}${u.username === me.user ? " (you: this signs you out)" : ""}?`)) return;
                              await api(`/dashboard/api/auth/accounts/${encodeURIComponent(u.username)}/delete`, "POST", {});
                              after();
                              return `Deleted ${u.username}.`;
                            })
                          }
                        >
                          <Trash2 /> Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
