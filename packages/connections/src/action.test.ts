import { expect, test } from "bun:test";
import { type Action, action, actionOf, actions, badActions } from "./action.ts";

test("actions(): the map comes back as is, keyed by name, each value an action", () => {
  const profile = action({ run: () => ({ login: "octocat" }) });
  const map = actions({ profile, sync: action({ every: 60_000, run: () => null }) });
  expect(Object.keys(map)).toEqual(["profile", "sync"]);
  expect(map.profile).toBe(profile);
  expect(actionOf(map.sync).every).toBe(60_000);
  // The key's type is the name; the value keeps the action's types.
  const typed: Action<undefined, { login: string }> = map.profile;
  expect(typed).toBe(profile);
  expect(actions({})).toEqual({});
});

test("actions(): bad names and non-actions fail when the file loads", () => {
  const run = action({ run: () => null });
  expect(() => actions({ "star.repo": run })).toThrow("actions: star.repo: an action's name is letters, digits, _ and - only");
  expect(() => actions({ then: run })).toThrow("then: an action's name is reserved");
  expect(() => actions({ toString: run })).toThrow("reserved");
  // @ts-expect-error a value must be an action()
  expect(() => actions({ profile: { run: () => null } })).toThrow("profile: must be an action({ ... })");
});

test("badActions: what withFolders checks a folder's default export with", () => {
  expect(badActions({ ok: action({ run: () => null }) })).toBeNull();
  expect(badActions(undefined)).toBe("the default export must be actions({ name: action({ ... }) })");
  expect(badActions([action({ run: () => null })])).toBe("the default export must be actions({ name: action({ ... }) })");
  expect(badActions({ x: 1 })).toBe("x: must be an action({ ... })");
});
