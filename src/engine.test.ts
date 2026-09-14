import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
  const t = await tempSetup();
  closers.push(t.cleanup);
  await t.write(
    "ops/backups.md",
    "# Backups\n\nNightly postgres snapshots.\n\n## Restore\n\nRun pg_restore twice.",
  );
  await t.write("dev/style.md", "# Style\n\nUse double quotes everywhere.");
  const primary = await Ragdown.start(t.config);
  closers.push(() => primary.close());
  await primary.sync(false);
  return { ...t, primary };
}

describe("Ragdown", () => {
  it("builds hook context and never repeats a chunk within a session", async () => {
    const { primary } = await setup();
    const prompt = "how do I restore postgres snapshots?";

    const context = await primary.context(prompt, "s1");
    expect(context).toMatch(/^<ragdown-context source=".*docs">/);
    expect(context).toContain("ops/backups.md");

    const again = await primary.context(prompt, "s1");
    for (const block of context?.match(/ops\/backups\.md:\d+-\d+/g) ?? []) {
      expect(again ?? "").not.toContain(block);
    }
    // A different session starts fresh.
    expect(await primary.context(prompt, "s2")).toContain("ops/backups.md");
  });

  it("adds nothing for short prompts, slash commands or a threshold nothing reaches", async () => {
    const { primary } = await setup();
    expect(await primary.context("yes")).toBeUndefined();
    expect(await primary.context("/compact restore postgres snapshots")).toBeUndefined();
    expect(
      await primary.context("how do I restore postgres snapshots?", undefined, { minScore: 1 }),
    ).toBeUndefined();
    const one = await primary.context("how do I restore postgres snapshots?", undefined, {
      topK: 1,
    });
    expect(one?.match(/similarity/g)).toHaveLength(1);
  });

  it("makes a second process a reader that forwards syncs to the primary", async () => {
    const t = await setup();
    const reader = await Ragdown.start(t.config);
    closers.push(() => reader.close());

    expect([t.primary.role, reader.role]).toEqual(["primary", "reader"]);
    await t.write("new.md", "# New\n\nKubernetes ingress notes.");
    expect(await reader.sync(false)).toMatchObject({ added: 1 });
    // The reader's own handle on the table sees the primary's commit.
    expect((await reader.recall("kubernetes ingress", 1))[0]?.path).toBe("new.md");
  });
});
