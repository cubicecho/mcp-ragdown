import { describe, expect, it } from "vitest";
import { tempSetup } from "../shared/testing.ts";
import { discoveryEndpoints, hostSlug } from "./discovery.ts";

describe("discoveryEndpoints", () => {
  it("names cards after the host, so two servers on one network stay apart", async () => {
    const t = await tempSetup({ SECURE_LOCAL_NET: "true", RAGDOWN_ROOT_MCP: "true" }, "folders");
    try {
      const [root] = await discoveryEndpoints(t.config, "NAS.lan");
      expect(root?.identifier).toBe("urn:air:nas.ragdown:mcp:root");
    } finally {
      await t.cleanup();
    }
  });

  it("keeps two folders apart whose names cut down to the same slug", async () => {
    const t = await tempSetup({ SECURE_LOCAL_NET: "true" }, "folders");
    try {
      await t.write("My Notes/.ragdown.json", JSON.stringify({ mcp: true }));
      await t.write("my-notes/.ragdown.json", JSON.stringify({ mcp: true }));
      await t.write("notes.v2/.ragdown.json", JSON.stringify({ mcp: true }));
      const endpoints = await discoveryEndpoints(t.config, "nas");
      expect(endpoints.map((endpoint) => [endpoint.path, endpoint.identifier])).toEqual([
        ["/mcp/My%20Notes", "urn:air:nas.ragdown:mcp:f-my-notes"],
        ["/mcp/my-notes", "urn:air:nas.ragdown:mcp:f-my-notes-2"],
        ["/mcp/notes.v2", "urn:air:nas.ragdown:mcp:f-notes-v2"],
      ]);
    } finally {
      await t.cleanup();
    }
  });
});

describe("hostSlug", () => {
  it.each([
    ["NAS", "nas"],
    ["my_box.lan", "my-box"],
    ["---", "host"],
  ])("%s → %s", (input, expected) => {
    expect(hostSlug(input)).toBe(expected);
  });
});
