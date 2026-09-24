import { describe, expect, it } from "vitest";
import { breadcrumb, chunkMarkdown, embeddingText, readDocMeta, readSupersedes } from "./chunk.ts";

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

describe("readSupersedes", () => {
  const front = (body: string) => `---\ntitle: New\n${body}\n---\n\n# New\n\nText.`;

  it("reads the scalar, inline-list and block-list forms", () => {
    expect(readSupersedes(front("supersedes: old.md"), "notes/new.md")).toEqual(["notes/old.md"]);
    expect(readSupersedes(front(`supersedes: [old.md, "older.md"]`), "notes/new.md")).toEqual([
      "notes/old.md",
      "notes/older.md",
    ]);
    expect(readSupersedes(front("supersedes:\n  - old.md\n  - older.md"), "new.md")).toEqual([
      "old.md",
      "older.md",
    ]);
  });

  it("resolves paths against the note's own folder, like a Markdown link", () => {
    expect(readSupersedes(front("supersedes: ../ops/old.md"), "notes/new.md")).toEqual([
      "ops/old.md",
    ]);
    // A path that climbs out of the docs folder is data from a file, not a path to follow.
    expect(readSupersedes(front("supersedes: ../../escape.md"), "notes/new.md")).toEqual([]);
    expect(readSupersedes(front("supersedes: /etc/passwd"), "notes/new.md")).toEqual([]);
  });

  it("is empty without frontmatter, and leaves the body alone", () => {
    expect(readSupersedes("# New\n\nsupersedes: old.md", "new.md")).toEqual([]);
    expect(readSupersedes(front("tags: [a]"), "new.md")).toEqual([]);
    // The block list stops at the next key rather than eating it.
    expect(readSupersedes(front("supersedes:\n  - old.md\ntags: [a]"), "new.md")).toEqual([
      "old.md",
    ]);
  });
});

describe("readDocMeta", () => {
  it("reads frontmatter and inline tags and aliases the way Obsidian does", () => {
    const source = [
      "---",
      "tags: [Ops, '#infra/db']",
      "aliases:",
      "  - Elephant",
      '  - "The DB"',
      "---",
      "# Postgres #heading-tag",
      "",
      "Vacuum nightly #maintenance and #2024 but not a#b or `#code`.",
      "",
      "```",
      "#include <stdio.h>",
      "```",
      "See https://example.com/#anchor and #nested/child/.",
    ].join("\n");
    expect(readDocMeta(source)).toEqual({
      tags: ["heading-tag", "infra/db", "maintenance", "nested/child", "ops"],
      aliases: ["Elephant", "The DB"],
    });
  });

  it("splits a tag string and keeps a string alias whole", () => {
    const source = ["---", "tags: one, two three", "aliases: Big, Old Name", "---", "x"].join("\n");
    expect(readDocMeta(source)).toEqual({
      tags: ["one", "three", "two"],
      aliases: ["Big, Old Name"],
    });
  });

  it("finds nothing in a plain note", () => {
    expect(readDocMeta("# Title\n\nText.")).toEqual({ tags: [], aliases: [] });
  });
});
