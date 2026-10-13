import { expect, test } from "bun:test";
import { parse } from "./args.ts";
import { parseEnv } from "./env.ts";

test("parseEnv: dotenv / .dev.vars syntax", () => {
  expect(
    parseEnv(`# comment
A=1
export B = two words  # trailing comment
C="quoted # not a comment\\nnext"
D='single \\n raw'
E=
not a line
F=x=y`),
  ).toEqual({ A: "1", B: "two words", C: "quoted # not a comment\nnext", D: "single \\n raw", E: "", F: "x=y" });
});

test("args: declared flags only, values inline or next", () => {
  const spec = { port: "string", tunnel: "boolean" } as const;
  expect(parse(["dev", "--port", "1", "--tunnel", "x"], spec)).toEqual({ command: "dev", flags: { port: "1", tunnel: true }, rest: ["x"] });
  expect(parse(["dev", "--port=2"], spec).flags).toEqual({ port: "2" });
  expect(parse(["-h"], spec).flags).toEqual({ help: true });
  expect(() => parse(["--nope"], spec)).toThrow("unknown flag --nope");
  expect(() => parse(["--tunnel=1"], spec)).toThrow("takes no value");
  expect(() => parse(["--port", "--tunnel"], spec)).toThrow("needs a value");
});
