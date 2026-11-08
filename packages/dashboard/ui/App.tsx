import { ChevronDown, KeyRound, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Me, Overview } from "../src/index.ts";
import { ApiError, addressable, api, signedOut } from "./api";
import { time } from "./format";
import { Loading, Problem, useHash, useLoad } from "./kit";
import { Accounts } from "./views/accounts";
import { Join, SignIn, Setup } from "./views/auth";
import { Connection } from "./views/connection";
import { Connections } from "./views/connections";
import { Keys } from "./views/keys";
import { Actions, Definitions } from "./views/overview";

/**
 * The dashboard's browser side (#32, #86): React and shadcn, bundled into assets.ts. Signed in by an
 * HttpOnly session cookie, never a key in the tab. Hash routes: `#/` connections (`?def=&state=&q=`),
 * `#/c/<def>/<id>` one connection, `#/actions`, `#/definitions`, `#/keys`, `#/accounts`; `#login=<token>`
 * (a CLI link) and `#invite=<token>` are taken out of the URL as soon as they're read.
 */

const NAV = [
  ["", "Connections"],
  ["actions", "Actions"],
  ["definitions", "Definitions"],
  ["keys", "Keys"],
  ["accounts", "Accounts"],
] as const;

/** A `#login=` or `#invite=` fragment, read once and dropped from the URL (and history). */
function fragment(): { login?: string; invite?: string } {
  const m = /^#(login|invite)=([^&]+)$/.exec(window.location.hash);
  if (!m) return {};
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  return { [m[1] as "login" | "invite"]: decodeURIComponent(m[2] as string) };
}

function Main({ me, changed }: { me: Me; changed: () => void }) {
  const { parts, query } = useHash();
  const o = useLoad(() => api<Overview>("/dashboard/api/overview"), []);
  const [view = "", ...args] = parts;
  const body = () => {
    if (view === "keys") return <Keys />;
    if (view === "accounts") return <Accounts me={me} changed={changed} />;
    if (o.error) return <Problem error={o.error} />;
    if (!o.data) return <Loading />;
    if (view === "c") {
      const [def = "", id = "", ...rest] = args;
      if (rest.length || !addressable(def) || !addressable(id)) return <Problem error={new Error(`Not a connection address: definition and id can't be empty, "." or "..".`)} />;
      return <Connection key={`${def}/${id}`} o={o.data} def={def} id={id} />;
    }
    if (view === "actions") return <Actions o={o.data} query={query} />;
    if (view === "definitions") return <Definitions o={o.data} />;
    return <Connections key={query.toString()} o={o.data} query={query} />;
  };
  const out = (everywhere: boolean) => api(`/dashboard/api/auth/${everywhere ? "signout" : "logout"}`, "POST", {}).finally(changed);
  return (
    <div className="min-h-svh">
      <header className="bg-background/95 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="flex items-center gap-2 font-semibold">
            <KeyRound className="size-4" /> connectd
          </span>
          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.map(([v, label]) => (
              <a
                key={v}
                href={`#/${v}`}
                aria-current={view === v || (v === "" && view === "c") ? "page" : undefined}
                className={cn("text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm", (view === v || (v === "" && view === "c")) && "bg-muted text-foreground")}
              >
                {label}
              </a>
            ))}
          </nav>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                {me.user ?? "root (CLI link)"} <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Session until {time(me.expiresAt)}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void out(false)}>
                <LogOut /> Sign out
              </DropdownMenuItem>
              {me.user ? <DropdownMenuItem onSelect={() => void out(true)}>Sign out everywhere</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {me.root ? (
          <Alert className="mb-6">
            <AlertDescription>
              <p>
                You're signed in with a one-time CLI link, until {time(me.expiresAt)}.{" "}
                <a className="underline" href="#/accounts">
                  Create an account
                </a>{" "}
                to sign in from any browser.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        {body()}
      </main>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me | null>("/dashboard/api/auth/me"));
    } catch (e) {
      if (!(e instanceof ApiError && e.fault.status === 401)) setError(e);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    signedOut(() => setMe(null));
    const f = fragment();
    if (f.invite) setInvite(f.invite);
    (f.login ? api("/dashboard/api/auth/login", "POST", { token: f.login }).catch(setError) : Promise.resolve()).then(refresh);
  }, [refresh]);

  if (invite) return <Join token={invite} done={() => (setInvite(null), refresh())} />;
  if (me === undefined)
    return (
      <div className="mx-auto max-w-md p-10">
        <Loading />
      </div>
    );
  if (me === null) return <SignIn done={() => (setError(null), refresh())} error={error} />;
  if (me.root && !skipped) return <Setup first={me.accounts === 0} done={refresh} skip={() => setSkipped(true)} />;
  return <Main me={me} changed={refresh} />;
}
