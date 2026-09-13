import { describe, expect, it } from "vitest";
import { breadcrumb, chunkMarkdown, embeddingText } from "./chunk.ts";

describe("chunkMarkdown", () => {
  it("scopes chunks by heading with a breadcrumb and original line numbers", () => {
    const source = [
      "# Backups", // 1
      "", // 2
      "We back up nightly.", // 3
      "", // 4
      "## Restore", // 5
      "", // 6
      "Run it twice.", // 7
      "", // 8
      "### Replication", // 9
      "Lag under a second.", // 10
    ].join("\n");
    const chunks = chunkMarkdown(source, "ops/backups.md");
    expect(chunks.map((c) => [c.heading, c.text, c.lineStart, c.lineEnd])).toEqual([
      ["Backups", "We back up nightly.", 3, 3],
      ["Backups › Restore", "Run it twice.", 7, 7],
      ["Backups › Restore › Replication", "Lag under a second.", 10, 10],
    ]);
    expect(chunks.every((c) => c.title === "Backups")).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("prefers the frontmatter title and counts frontmatter lines", () => {
    const source = ["---", 'title: "Runbook"', "tags: [ops]", "---", "Intro text."].join("\n");
    const [chunk] = chunkMarkdown(source, "x.md");
    expect(chunk).toMatchObject({
      title: "Runbook",
      heading: "",
      text: "Intro text.",
      lineStart: 5,
    });
  });

  it("falls back to the file name for the title", () => {
    expect(chunkMarkdown("Just text.", "notes/todo-list.md")[0]?.title).toBe("todo-list");
  });

  it("treats # inside fenced code as code, not a heading", () => {
    const source = ["## Script", "```sh", "# not a heading", "", "echo hi", "```"].join("\n");
    const chunks = chunkMarkdown(source, "x.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("Script");
    expect(chunks[0]?.text).toContain("# not a heading\n\necho hi");
  });

  it("skips headings with no text of their own", () => {
    const chunks = chunkMarkdown("# A\n## B\nbody", "x.md");
    expect(chunks.map((c) => c.heading)).toEqual(["A › B"]);
  });

  it("gives a file with no body text one chunk, so the index knows the file", () => {
    expect(chunkMarkdown("# Stub\n## Todo", "stub.md")).toMatchObject([
      { title: "Stub", heading: "", text: "# Stub\n## Todo", lineStart: 1, lineEnd: 2 },
    ]);
    expect(chunkMarkdown("", "empty.md")).toMatchObject([{ title: "empty", text: "empty" }]);
  });

  it("packs paragraphs up to the limit and hard-splits oversized ones", () => {
    const para = (n: number) => `${"word ".repeat(n).trim()}`;
    const source = [para(10), "", para(10), "", "x".repeat(250)].join("\n");
    const chunks = chunkMarkdown(source, "x.md", 120);
    expect(chunks.every((c) => c.text.length <= 120)).toBe(true);
    // The two short paragraphs share a chunk; the 250-character line becomes three.
    expect(chunks[0]?.text).toBe(`${para(10)}\n\n${para(10)}`);
    expect(chunks.slice(1).map((c) => c.text.length)).toEqual([120, 120, 10]);
    expect(chunks.slice(1).every((c) => c.lineStart === 5 && c.lineEnd === 5)).toBe(true);
  });
});

describe("breadcrumb", () => {
  it("drops the title when the heading path already starts with it", () => {
    expect(breadcrumb("Backups", "Backups › Restore")).toBe("Backups › Restore");
    expect(breadcrumb("Runbook", "Restore")).toBe("Runbook › Restore");
    expect(breadcrumb("Backups", "Backups")).toBe("Backups");
    expect(breadcrumb("Backups", "")).toBe("Backups");
  });

  it("leads the embedded text", () => {
    expect(embeddingText({ title: "T", heading: "T › H", text: "body" })).toBe("T › H\n\nbody");
  });
});
