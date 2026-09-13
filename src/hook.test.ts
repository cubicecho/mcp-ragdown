import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { runHook } from "./hook.ts";
import { NoPrimaryError, request } from "./primary.ts";
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
  return t;
}

const event = (prompt: string, session_id = "s1") => ({
  hook_event_name: "UserPromptSubmit",
  session_id,
  prompt,
});

function contextOf(output: string | undefined): string | undefined {
  return output
    ? (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext
    : undefined;
}

describe("hook", () => {
  it("asks the running primary and never repeats a chunk within a session", async () => {
    const t = await setup();
    const primary = await Ragdown.start(t.config);
    closers.push(() => primary.close());
    await primary.sync(false);

    const noStart = { start: () => Promise.reject(new Error("should use the socket")) };
    const output = await runHook(event("how do I restore postgres snapshots?"), t.config, noStart);
    expect(JSON.parse(output ?? "{}").hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = contextOf(output);
    expect(context).toMatch(/^<ragdown-context source=".*docs">/);
    expect(context).toContain("ops/backups.md");

    const again = contextOf(
      await runHook(event("how do I restore postgres snapshots?"), t.config, noStart),
    );
    for (const block of context?.match(/ops\/backups\.md:\d+-\d+/g) ?? []) {
      expect(again ?? "").not.toContain(block);
    }
    // A different session starts fresh.
    expect(
      contextOf(
        await runHook(event("how do I restore postgres snapshots?", "s2"), t.config, noStart),
      ),
    ).toContain("ops/backups.md");
  });

  it("adds nothing for short prompts, slash commands and other events", async () => {
    const t = await setup();
    const primary = await Ragdown.start(t.config);
    closers.push(() => primary.close());
    await primary.sync(false);

    expect(await runHook(event("yes"), t.config)).toBeUndefined();
    expect(await runHook(event("/compact restore postgres snapshots"), t.config)).toBeUndefined();
    expect(
      await runHook({ ...event("restore postgres snapshots"), hook_event_name: "Stop" }, t.config),
    ).toBeUndefined();
  });

  it("becomes the primary in-process when none is running", async () => {
    const t = await setup();
    await expect(request(t.config.socketPath, { op: "context" }, 1000)).rejects.toBeInstanceOf(
      NoPrimaryError,
    );

    let started = 0;
    const start = async (config: typeof t.config) => {
      started++;
      const rag = await Ragdown.start(config);
      // A first sync is not awaited by the engine; the in-process hook of a test must see the files.
      await rag.sync(false);
      return rag;
    };
    const context = contextOf(
      await runHook(event("how do I restore postgres snapshots?"), t.config, { start }),
    );
    expect(started).toBe(1);
    expect(context).toContain("ops/backups.md");
    // The in-process primary released the socket on the way out.
    await expect(request(t.config.socketPath, { op: "context" }, 1000)).rejects.toBeInstanceOf(
      NoPrimaryError,
    );
  });

  it("makes a second process a reader that forwards syncs to the primary", async () => {
    const t = await setup();
    const primary = await Ragdown.start(t.config);
    closers.push(() => primary.close());
    await primary.sync(false);
    const reader = await Ragdown.start(t.config);
    closers.push(() => reader.close());

    expect([primary.role, reader.role]).toEqual(["primary", "reader"]);
    await t.write("new.md", "# New\n\nKubernetes ingress notes.");
    expect(await reader.sync(false)).toMatchObject({ added: 1 });
    // The reader's own handle on the table sees the primary's commit.
    expect((await reader.recall("kubernetes ingress", 1))[0]?.path).toBe("new.md");
  });
});
