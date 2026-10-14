import { describe, expect, it } from "vitest";
import { exactNames, holdsName, namesSomething } from "./identifiers.ts";

describe("namesSomething", () => {
  it("finds the shapes a name takes", () => {
    for (const query of [
      "which step runs `veltra build kestrel`?",
      "what is max_batch_size for staging?",
      "where is src/cli.ts loaded?",
      "why does fetchUserProfile fail?",
      "what raises KeyError here?",
      "add a --dry-run flag",
      "does it run on k8s?",
      "is the file utf-8?",
      "which service broke after the 4.2 release?",
    ]) {
      expect(namesSomething(query), query).toBe(true);
    }
  });

  it("leaves prose alone", () => {
    for (const query of [
      "Which team owns Kestrel Scheduler?",
      "how do I restore postgres?",
      "is the runbook up-to-date, e.g. for the 2nd region?",
      "who approves staging deploys - and when?",
      "meet at 10:30 to go over the outage",
    ]) {
      expect(namesSomething(query), query).toBe(false);
    }
  });
});

describe("exactNames", () => {
  it("keeps commands and shaped names, lowercased", () => {
    expect(exactNames("after `veltra canary kestrel --percent=5`, what runs?")).toEqual([
      "veltra canary kestrel --percent=5",
    ]);
    expect(exactNames("where is `pg_restore` used, and src/cli.ts?")).toEqual([
      "pg_restore",
      "src/cli.ts",
    ]);
    expect(exactNames("why does fetchUserProfile throw?")).toEqual(["fetchuserprofile"]);
    expect(exactNames("is `http://localhost:8177/healthz` up, or `kestrel-scheduler`?")).toEqual([
      "http://localhost:8177/healthz",
      "kestrel-scheduler",
    ]);
  });

  it("drops a plain word in backticks and an unquoted number", () => {
    expect(exactNames("bump `typescript` to 5.9")).toEqual([]);
    expect(exactNames("what broke after the 4.2 release?")).toEqual([]);
    expect(exactNames("where is `4.7.1` pinned?")).toEqual(["4.7.1"]);
  });
});

describe("holdsName", () => {
  it("matches a whole name, case-insensitively", () => {
    expect(holdsName("Run PG_RESTORE twice.", ["pg_restore"])).toBe(true);
    expect(holdsName("Run pg_restore_all twice.", ["pg_restore"])).toBe(false);
    expect(holdsName("version 15.9", ["5.9"])).toBe(false);
    expect(holdsName("pass --dry-run=true", ["--dry-run"])).toBe(true);
    expect(holdsName("anything", [])).toBe(false);
  });
});
