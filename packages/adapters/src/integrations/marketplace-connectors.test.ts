import { expect, it, vi } from "vitest";
import { createMarketplaceConnectors } from "./marketplace-connectors.js";

const sha = "c".repeat(40);
const raw = `https://raw.githubusercontent.com/example/skills/${sha}/`;

/** A fake GitHub: the xAI registry lists one pinned plugin that brings a remote server. */
function reader() {
  const files: Record<string, string> = {
    "xai-org/plugin-marketplace/HEAD/.grok-plugin/marketplace.json": JSON.stringify({
      name: "xai",
      plugins: [
        {
          name: "cloud",
          description: "Cloud platform",
          source: { source: "url", url: "https://github.com/example/skills.git", sha },
        },
      ],
    }),
    "xai-org/plugin-marketplace/HEAD/.grok-plugin/plugin-index.json": JSON.stringify({
      version: 1,
      plugins: {
        cloud: {
          sha,
          components: {
            mcpServers: [{ name: "cloud", description: "http" }],
            skills: [{ name: "deploy", description: "Deploy" }],
          },
        },
      },
    }),
    "cursor/plugins/HEAD/.cursor-plugin/marketplace.json": JSON.stringify({ plugins: [] }),
    [`${raw}.cursor-plugin/plugin.json`.slice("https://raw.githubusercontent.com/".length)]:
      JSON.stringify({ name: "cloud" }),
    [`${raw}.mcp.json`.slice("https://raw.githubusercontent.com/".length)]: JSON.stringify({
      mcpServers: { cloud: { type: "http", url: "https://mcp.cloud.example.test/mcp" } },
    }),
  };
  return vi.fn(async (url: string) => {
    if (url.includes("api.github.com/repos/cursor/plugins/git/trees/"))
      return JSON.stringify({ tree: [] });
    const found = Object.entries(files).find(([path]) => url.endsWith(path));
    if (found) return found[1];
    throw new Error("Request failed: HTTP 404");
  });
}

it("reads a pinned plugin's server from its declaration files alone", async () => {
  const read = reader();
  // A full preview would fetch every skill; the declaration files are all it needs.
  const fetcher = vi.fn();
  const found = await createMarketplaceConnectors({ read, fetcher }).find(
    "Cloud",
    new AbortController().signal,
  );
  expect(found).toEqual({
    name: "Cloud",
    description: "Cloud platform",
    logo: null,
    server: {
      name: "cloud",
      transport: "streamable_http",
      endpoint: "https://mcp.cloud.example.test/mcp",
      headers: {},
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith(`${raw}.mcp.json`, 256_000, expect.any(AbortSignal));
});

it("finds nothing for a name no listing has", async () => {
  await expect(
    createMarketplaceConnectors({ read: reader() }).find("Elsewhere", new AbortController().signal),
  ).resolves.toBeNull();
});
