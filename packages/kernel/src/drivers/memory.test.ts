import { expect, test } from "bun:test";
import { memory } from "./memory.ts";
import { parity, probe } from "./parity.ts";

parity("memory", () => memory(probe), { test, expect });
