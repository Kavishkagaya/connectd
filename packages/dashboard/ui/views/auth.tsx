import { Fingerprint, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../api";
import { Mono, Problem, useAct } from "../kit";
import * as passkey from "../passkey";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-svh items-center justify-center p-6">
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold">
        <KeyRound className="size-5" /> connectd
      </div>
      {children}
    </div>
  </div>
);

/** Signed out: a passkey, a password, or the CLI link. */
export function SignIn({ done, error }: { done: () => void; error?: unknown }) {
  const a = useAct();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await api("/dashboard/api/auth/password", "POST", { username, password });
      done();
    });
  };
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>To this deployment's dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Problem error={a.error ?? error} title="Couldn't sign in" />
          {passkey.supported() ? (
            <>
              <Button type="button" disabled={a.busy} onClick={() => a.run(async () => (await passkey.signIn(), done()))}>
                <Fingerprint /> Sign in with a passkey
              </Button>
              <div className="text-muted-foreground flex items-center gap-3 text-xs">
                <Separator className="flex-1" /> or <Separator className="flex-1" />
              </div>
            </>
          ) : null}
          <form className="grid gap-3" onSubmit={submit}>
            <div className="grid gap-1.5">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username webauthn" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" variant="outline" disabled={a.busy}>
              Sign in with password
            </Button>
          </form>
        </CardContent>
        <CardFooter className="text-muted-foreground text-xs">
          <p>
            No account yet? In your project, run <Mono>connectd dashboard</Mono> (add <Mono>--env production</Mono> for a deployment): it opens this page signed in.
          </p>
        </CardFooter>
      </Card>
    </Shell>
  );
}

/** Username, then a passkey (suggested) or a password. Used by the first-account setup and by invites. */
function AccountForm({ submit, cta }: { submit: (username: string, password: string | null, passkeyName: string | null) => Promise<void>; cta: string }) {
  const a = useAct();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const can = passkey.supported();
  const [how, setHow] = useState(can ? "passkey" : "password");
  const go = (e: FormEvent) => {
    e.preventDefault();
    a.run(() => submit(username.trim().toLowerCase(), how === "password" ? password : null, how === "passkey" ? `${navigator.platform || "this device"}` : null));
  };
  return (
    <form className="grid gap-4" onSubmit={go}>
      <Problem error={a.error} />
      <div className="grid gap-1.5">
        <Label htmlFor="new-username">Username</Label>
        <Input id="new-username" name="username" autoComplete="username" required pattern="[a-z0-9][a-z0-9._\-]{1,31}" value={username} onChange={(e) => setUsername(e.target.value)} />
        <p className="text-muted-foreground text-xs">Lowercase letters, digits and . _ -</p>
      </div>
      <Tabs value={how} onValueChange={setHow}>
        <TabsList className="w-full">
          <TabsTrigger value="passkey" disabled={!can}>
            Passkey
          </TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
        </TabsList>
        <TabsContent value="passkey" className="text-muted-foreground text-sm">
          Face ID, Touch ID, Windows Hello or a security key. Nothing to remember, and it can't be phished. Suggested.
        </TabsContent>
        <TabsContent value="password" className="grid gap-1.5">
          <Label htmlFor="new-password">Password</Label>
          <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} required={how === "password"} value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-muted-foreground text-xs">At least 12 characters. You can add a passkey later.</p>
        </TabsContent>
      </Tabs>
      <Button type="submit" disabled={a.busy}>
        {cta}
      </Button>
    </form>
  );
}

/** A root session (from a CLI link): make an account, so the next sign-in needs no CLI. */
export function Setup({ done, skip, first }: { done: () => void; skip?: () => void; first: boolean }) {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>{first ? "Create the first account" : "Create your account"}</CardTitle>
          <CardDescription>You're signed in with a one-time link from the CLI. With an account you can sign in from any browser, without the CLI.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountForm
            cta="Create account"
            submit={async (username, password, key) => {
              await api("/dashboard/api/auth/accounts", "POST", { username, ...(password === null ? {} : { password }) });
              if (key) await passkey.register(key);
              done();
            }}
          />
        </CardContent>
        {skip ? (
          <CardFooter>
            <Button variant="ghost" size="sm" onClick={skip}>
              Not now
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </Shell>
  );
}

/** An invite link: make an account. */
export function Join({ token, done }: { token: string; done: () => void }) {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Join this dashboard</CardTitle>
          <CardDescription>You were invited to manage this connectd deployment.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountForm
            cta="Join"
            submit={async (username, password, key) => {
              await api("/dashboard/api/auth/join", "POST", { token, username, ...(password === null ? {} : { password }) });
              if (key) await passkey.register(key);
              done();
            }}
          />
        </CardContent>
      </Card>
    </Shell>
  );
}
