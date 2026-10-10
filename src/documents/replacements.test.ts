import { describe, expect, it } from "vitest";
import { applyReplacements } from "./replacements.ts";

const text = "# Backups\n\nNightly snapshots.\n\n## Restore\n\nRun pg_restore twice.\n";

describe("applyReplacements", () => {
  it("swaps one passage and leaves the rest as it was", () => {
    expect(applyReplacements(text, [{ oldText: "twice", newText: "once" }])).toEqual({
      text: "# Backups\n\nNightly snapshots.\n\n## Restore\n\nRun pg_restore once.\n",
      replaced: 1,
    });
  });

  it("makes each replacement on the result of the one before", () => {
    const edited = applyReplacements(text, [
      { oldText: "Nightly", newText: "Hourly" },
      { oldText: "Hourly snapshots.", newText: "Hourly snapshots, kept a week." },
      { oldText: "\n## Restore\n\nRun pg_restore twice.\n", newText: "" },
    ]);
    expect(edited).toEqual({
      text: "# Backups\n\nHourly snapshots, kept a week.\n",
      replaced: 3,
    });
  });

  it("refuses a passage that is missing, or there more than once", () => {
    expect(() => applyReplacements(text, [{ oldText: "thrice", newText: "once" }])).toThrow(
      expect.objectContaining({ status: 404, message: expect.stringMatching(/^edit 1 of 1: /) }),
    );
    // Whitespace counts: a passage is matched exactly or not at all.
    expect(() =>
      applyReplacements(text, [{ oldText: "Nightly  snapshots", newText: "x" }]),
    ).toThrow(expect.objectContaining({ status: 404 }));
    expect(() =>
      applyReplacements(text, [
        { oldText: "twice", newText: "once" },
        { oldText: "s", newText: "z" },
      ]),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        message: expect.stringMatching(/^edit 2 of 2: .* 6 times/),
      }),
    );
    expect(() => applyReplacements(text, [{ oldText: "twice", newText: "twice" }])).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("shows the passage a missing one most likely meant", () => {
    const spaced = "Nightly  snapshots.\n\n\n## Restore";
    expect(() => applyReplacements(text, [{ oldText: spaced, newText: "x" }])).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /The nearest passage \(lines 3-5\) follows; copy old_text from it exactly:\nNightly snapshots\.\n\n## Restore$/,
        ),
      }),
    );
    // What follows its first line is out of date: the lines there now are what it is shown.
    const stale = "## Restore\n\nRun pg_restore (once).";
    expect(() => applyReplacements(text, [{ oldText: stale, newText: "x" }])).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /\(lines 5-7\) follows.*:\n## Restore\n\nRun pg_restore twice\.$/s,
        ),
      }),
    );
    // After an earlier edit the lines are no longer the file's, so none are named.
    expect(() =>
      applyReplacements(text, [
        { oldText: "# Backups\n\n", newText: "" },
        { oldText: "Nightly  snapshots.", newText: "x" },
      ]),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/The nearest passage follows; .*:\nNightly snapshots\.$/s),
      }),
    );
    expect(() => applyReplacements(text, [{ oldText: "thrice", newText: "x" }])).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/read the document again/) }),
    );
  });

  it("replaces every occurrence when asked, taking the new text literally", () => {
    expect(
      applyReplacements("a.b a.b", [{ oldText: "a.b", newText: "$& $1", replaceAll: true }]),
    ).toEqual({ text: "$& $1 $& $1", replaced: 2 });
  });

  it("matches across a CRLF file's line endings", () => {
    const edited = applyReplacements("One\r\nTwo\r\nThree\r\n", [
      { oldText: "One\nTwo", newText: "1\n2" },
    ]);
    expect(edited.text).toBe("1\n2\nThree\n");
  });
});
