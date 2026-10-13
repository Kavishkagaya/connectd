import { spawn } from "node:child_process";

/** The quick tunnel's public URL in a line of cloudflared's log (it prints it in a box on stderr). */
export const tunnelUrl = (text: string) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;

export const NO_CLOUDFLARED = `--tunnel needs cloudflared on your PATH (a Cloudflare quick tunnel: no account, a new https URL each run).
  macOS:   brew install cloudflared
  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
Or run any tunnel yourself (ngrok, a named cloudflared tunnel) and pass its URL with --url https://...`;

/**
 * `cloudflared tunnel --url http://localhost:<port>`, resolved with the public URL once it's printed.
 * `bin` is for tests (a fake cloudflared). Rejects with NO_CLOUDFLARED when it isn't installed.
 */
export function tunnel(port: number, o: { bin?: string; timeoutMs?: number } = {}): Promise<{ url: string; stop(): void }> {
  return new Promise((resolve, reject) => {
    const p = spawn(o.bin ?? "cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let up = false;
    const stop = () => ((up = false), p.kill());
    const timer = setTimeout(() => (stop(), reject(new Error(`cloudflared printed no tunnel URL:\n${log.slice(-2000)}`))), o.timeoutMs ?? 30_000);
    const fail = (e: Error) => (clearTimeout(timer), reject(e));
    const read = (b: Buffer) => {
      log += b.toString();
      const url = tunnelUrl(log);
      if (url && !up) (up = true), clearTimeout(timer), resolve({ url, stop });
    };
    p.stdout.on("data", read);
    p.stderr.on("data", read);
    p.on("error", (e: NodeJS.ErrnoException) => fail(e.code === "ENOENT" ? new Error(NO_CLOUDFLARED) : e));
    p.on("exit", (code) => (up ? console.error(`cloudflared exited (${code}); the tunnel URL is gone`) : fail(new Error(`cloudflared exited (${code}):\n${log.slice(-2000)}`))));
  });
}
