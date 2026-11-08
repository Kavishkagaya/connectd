import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import type { Prompts } from "./target.ts";

export type { Choice, Prompts } from "./target.ts";

/** A person at a terminal: not CI, not a test run (`bun test` sets NODE_ENV=test), where a question would wait forever. */
export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && process.env.NODE_ENV !== "test");

/** One readline per question: commands run between questions (an install, `wrangler login`) need the terminal to themselves. */
async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

export const terminal: Prompts = {
  async choose(question, choices) {
    const list = choices.map((c, i) => `  ${i + 1}) ${c.label}`).join("\n");
    for (;;) {
      const a = await ask(`${question}\n${list}\nChoose [1]: `);
      const c = a === "" ? choices[0] : choices[Number(a) - 1];
      if (c) return c.value;
    }
  },
  async confirm(question, fallback = true) {
    for (;;) {
      const a = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      if (a === "") return fallback;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
    }
  },
  async text(question, fallback) {
    return (await ask(`${question}${fallback ? ` [${fallback}]` : ""}: `)) || fallback;
  },
  checklist(question, choices) {
    const { stdin, stdout } = process;
    const on = new Set<number>();
    let at = 0;
    const width = Math.max(...choices.map((c) => c.label.length));
    const draw = (again: boolean) => {
      if (again) stdout.write(`\x1b[${choices.length}A`);
      choices.forEach((c, i) => stdout.write(`\x1b[2K${i === at ? "\x1b[36m›\x1b[0m" : " "} [${on.has(i) ? "x" : " "}] ${c.label.padEnd(width)}${c.hint ? `  \x1b[2m${c.hint}\x1b[0m` : ""}\n`));
    };
    stdout.write(`${question}  \x1b[2m(↑/↓ move, space ticks, enter confirms)\x1b[0m\n`);
    draw(false);
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise((resolve) => {
      const done = () => {
        stdin.off("keypress", key);
        stdin.setRawMode(false);
        stdin.pause();
      };
      const toggle = (i: number) => {
        if (on.delete(i)) return;
        // "Add later" and the rest exclude each other.
        for (const j of [...on]) if (choices[j]?.alone || choices[i]?.alone) on.delete(j);
        on.add(i);
      };
      function key(_: string, k: { name?: string; ctrl?: boolean }) {
        if (k.ctrl && k.name === "c") {
          done();
          process.exit(130);
        }
        if (k.name === "up" || k.name === "k") at = (at + choices.length - 1) % choices.length;
        else if (k.name === "down" || k.name === "j") at = (at + 1) % choices.length;
        else if (k.name === "space") toggle(at);
        else if (k.name === "return") {
          done();
          return resolve([...on].sort((a, b) => a - b).flatMap((i) => (choices[i]?.alone ? [] : [choices[i]?.value ?? ""])));
        } else return;
        draw(true);
      }
      stdin.on("keypress", key);
    });
  },
};
