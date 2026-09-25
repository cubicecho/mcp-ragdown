import { describe, expect, it } from "vitest";
import { findLinks, parseLink, resolveLink, resolveRef } from "./links.ts";

const notes = [
  { path: "Home.md", aliases: [] },
  { path: "projects/alpha/Plan.md", aliases: ["Alpha plan"] },
  { path: "projects/beta/Plan.md", aliases: [] },
  { path: "archive/old/projects/alpha/Plan.md", aliases: [] },
  { path: "notes/Kafka.md", aliases: ["Streams"] },
];
const attachments = ["assets/diagram.png", "projects/alpha/diagram.png", "file with space.pdf"];

describe("parseLink", () => {
  it("strips the brackets, the embed mark, the display text and block references", () => {
    expect(parseLink("![[Note#Heading|shown]]")).toEqual({ target: "Note", anchor: "Heading" });
    expect(parseLink("Note#^block")).toEqual({ target: "Note", anchor: undefined });
    expect(parseLink("#Only heading")).toEqual({ target: "", anchor: "Only heading" });
    expect(parseLink("./a%20b.md")).toEqual({ target: "a b.md", anchor: undefined });
  });
});

describe("resolveLink", () => {
  const resolve = (link: string, from?: string) => resolveLink(link, from, notes, attachments);

  it("takes an exact path, with or without the extension, before a name", () => {
    expect(resolve("projects/beta/Plan")).toEqual({ path: "projects/beta/Plan.md" });
    expect(resolve("home.md")).toEqual({ path: "Home.md" });
    expect(resolve("Plan", "projects/beta/Other.md")).toEqual({ path: "projects/beta/Plan.md" });
  });

  it("breaks name ties by the linking note's folder, then the shortest path", () => {
    expect(resolve("plan", "projects/alpha/x.md")).toEqual({ path: "projects/alpha/Plan.md" });
    expect(resolve("Plan", "Home.md")).toEqual({ path: "projects/beta/Plan.md" });
    expect(resolve("alpha/Plan", "Home.md")).toEqual({ path: "projects/alpha/Plan.md" });
  });

  it("falls back to aliases and keeps the heading", () => {
    expect(resolve("streams#Retention")).toEqual({ path: "notes/Kafka.md", anchor: "Retention" });
    expect(resolve("Alpha plan")).toEqual({ path: "projects/alpha/Plan.md" });
  });

  it("resolves attachments and same-note headings, and nothing else", () => {
    expect(resolve("diagram.png", "projects/alpha/Plan.md")).toEqual({
      path: "projects/alpha/diagram.png",
    });
    expect(resolve("diagram.png", "Home.md")).toEqual({ path: "assets/diagram.png" });
    expect(resolve("file%20with%20space.pdf")).toEqual({ path: "file with space.pdf" });
    expect(resolve("#Top", "Home.md")).toEqual({ path: "Home.md", anchor: "Top" });
    expect(resolve("Missing")).toBeUndefined();
    expect(resolve("../outside")).toBeUndefined();
  });
});

describe("findLinks", () => {
  it("finds wikilinks and relative Markdown links, outside code, with the target's offsets", () => {
    const text = [
      "See [[Plan#Goals|the plan]] and ![[diagram.png]].",
      "Also [kafka](../notes/Kafka.md#Setup), [web](https://x.test) and [top](#top).",
      "`[[Not a link]]` and",
      "```",
      "[[Nor this]]",
      "```",
    ].join("\n");
    const refs = findLinks(text);
    expect(refs.map((ref) => [ref.kind, ref.raw, ref.target, ref.line])).toEqual([
      ["wiki", "Plan#Goals|the plan", "Plan", 1],
      ["wiki", "diagram.png", "diagram.png", 1],
      ["markdown", "../notes/Kafka.md#Setup", "../notes/Kafka.md", 2],
    ]);
    for (const ref of refs) expect(text.slice(ref.targetStart, ref.targetEnd)).toBe(ref.target);
  });

  it("resolves a Markdown link only as a path relative to its note", () => {
    const [ref] = findLinks("[k](../notes/Kafka.md)");
    expect(ref && resolveRef(ref, "projects/x.md", notes)).toBe("notes/Kafka.md");
    const [byName] = findLinks("[k](Kafka.md)");
    expect(byName && resolveRef(byName, "projects/x.md", notes)).toBeUndefined();
    const [wiki] = findLinks("[[Streams]]");
    expect(wiki && resolveRef(wiki, "Home.md", notes)).toBe("notes/Kafka.md");
  });
});
