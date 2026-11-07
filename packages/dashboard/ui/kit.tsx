import { AlertCircle, Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Load `f` on mount and when `deps` change; `reload` runs it again. */
export function useLoad<T>(f: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    let live = true;
    set((s) => ({ ...s, loading: true }));
    f().then(
      (data) => live && set({ data, loading: false }),
      (error) => live && set({ error, loading: false }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

/** Run an action (a click, a submit): busy while it runs, its error or note shown after. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<ReactNode>(null);
  const run = async (f: () => Promise<ReactNode | void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const n = await f();
      if (n) setNote(n);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, run, clear: () => (setError(null), setNote(null)) };
}

export function Problem({ error, title = "Something went wrong" }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}

export function Note({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Alert className="border-success/40 text-success" role="status">
      <Check />
      <AlertDescription className="text-success">{children}</AlertDescription>
    </Alert>
  );
}

export const Loading = () => (
  <div className="space-y-3" aria-label="loading">
    <Skeleton className="h-8 w-1/3" />
    <Skeleton className="h-24 w-full" />
  </div>
);

const STATES: Record<string, string> = {
  active: "border-success/50 text-success",
  pending: "border-warning/50 text-warning",
  reauth_required: "border-warning/50 text-warning",
  revoked: "text-muted-foreground",
  rolling: "border-warning/50 text-warning",
};
export const State = ({ state }: { state: string }) => (
  <Badge variant="outline" className={cn("font-mono", STATES[state])}>
    {state}
  </Badge>
);

export function PageTitle({ title, children, description }: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <code className={cn("bg-muted rounded px-1.5 py-0.5 font-mono text-xs break-all", className)}>{children}</code>;

export function Pairs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Json = ({ value }: { value: unknown }) => <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;

/** A value to copy (a new secret, an env line): shown, with a copy button. */
export function Copyable({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="bg-muted flex items-start gap-2 rounded-md p-3">
      <pre className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">{value}</pre>
      <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={label}>
        {done ? <Check /> : <Copy />}
        {done ? "Copied" : label}
      </Button>
    </div>
  );
}

/** `#/a/b?x=1`: the view's path parts and query. */
export function useHash() {
  const read = () => {
    const [path = "", query = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
    return { parts: path.split("/").map((p) => decodeURIComponent(p)), query: new URLSearchParams(query) };
  };
  const [h, set] = useState(read);
  useEffect(() => {
    const on = () => set(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

export const hash = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
