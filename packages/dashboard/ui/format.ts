/** `10 min`, `1 h`, `90 s`. */
export function every(ms: number) {
  for (const [unit, n] of [["d", 86_400_000], ["h", 3_600_000], ["min", 60_000], ["s", 1000]] as const) if (ms >= n && ms % n === 0) return `${ms / n} ${unit}`;
  return `${ms} ms`;
}

export const time = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—");

export const trigger = (a: { every: number | null; on: string | null }) => (a.every !== null ? `every ${every(a.every)}` : a.on !== null ? `on ${a.on}` : "called by the app");

export type Field = { name: string; kind: "string" | "number" | "integer" | "boolean" | "enum"; options: string[]; required: boolean; description: string };
/**
 * The fields of a flat object schema (strings, numbers, booleans, string enums), or null when it's
 * anything else: then the form is a JSON text box. The runtime checks the input either way.
 */
export function fields(schema: unknown): Field[] | null {
  const s = schema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown } | null;
  if (!s || s.type !== "object" || !s.properties || typeof s.properties !== "object") return null;
  const required = Array.isArray(s.required) ? s.required : [];
  const out: Field[] = [];
  for (const [name, raw] of Object.entries(s.properties)) {
    const p = raw as { type?: unknown; enum?: unknown; description?: unknown } | null;
    if (!p || typeof p !== "object") return null;
    const description = typeof p.description === "string" ? p.description : "";
    if (Array.isArray(p.enum) && p.enum.length && p.enum.every((v) => typeof v === "string")) out.push({ name, kind: "enum", options: p.enum as string[], required: required.includes(name), description });
    else if (p.type === "string" || p.type === "number" || p.type === "integer" || p.type === "boolean") out.push({ name, kind: p.type, options: [], required: required.includes(name), description });
    else return null;
  }
  return out;
}

/** A link the API handed us: http(s) only, so a `javascript:` URL can't get in. */
export const safeUrl = (url: string) => /^https?:\/\//i.test(url);
