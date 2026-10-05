import { describe, expect, it } from "vitest";
import { buildTree, type TreeNode } from "./file-tree.ts";

const shape = (nodes: TreeNode[]): unknown =>
  nodes.map((node) => (node.type === "dir" ? { [node.name]: shape(node.children) } : node.name));

describe("buildTree", () => {
  it("nests files under the folders their paths name, adding the ones the list leaves out", () => {
    const tree = buildTree([
      { path: "ideas/deep/a.md", type: "file" },
      { path: "readme.md", type: "file" },
    ]);
    expect(shape(tree)).toEqual([{ ideas: [{ deep: ["a.md"] }] }, "readme.md"]);
    expect(tree[0]).toMatchObject({ path: "ideas", type: "dir" });
    expect(tree[0]?.entry).toBeUndefined();
    expect(tree[0]?.children[0]?.path).toBe("ideas/deep");
  });

  it("sorts folders first and then by name at every level", () => {
    const tree = buildTree([
      { path: "b.md", type: "file" },
      { path: "z/b.md", type: "file" },
      { path: "a.md", type: "file" },
      { path: "z/y/c.md", type: "file" },
      { path: "m/a.md", type: "file" },
    ]);
    expect(shape(tree)).toEqual([
      { m: ["a.md"] },
      { z: [{ y: ["c.md"] }, "b.md"] },
      "a.md",
      "b.md",
    ]);
  });

  it("keeps each entry on its node, a listed folder's included", () => {
    const file = { path: "notes/a.md", type: "file" as const, size: 3 };
    const dir = { path: "notes", type: "dir" as const, size: 0 };
    const tree = buildTree([file, dir]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.entry).toBe(dir);
    expect(tree[0]?.children[0]?.entry).toBe(file);
  });
});
