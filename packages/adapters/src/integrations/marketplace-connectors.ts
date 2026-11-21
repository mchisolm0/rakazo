import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import type {
  PluginMcpServerEntry,
  PluginRepoFetcher,
  PluginTextReader,
} from "./plugin-connectors.js";
import {
  parsePluginDirectory,
  parsePluginSource,
  previewPluginInstall,
} from "./plugin-connectors.js";
import { createPluginMarketplace, publicRead } from "./plugin-marketplace.js";

/** A marketplace plugin's remote connector, as a bot can offer it from chat. */
export type MarketplaceConnector = {
  name: string;
  description: string;
  logo: string | null;
  server: PluginMcpServerEntry;
};

export type MarketplaceConnectors = {
  /** The listed plugin named `app` when it brings exactly one remote server that needs no
   * credentials typed in, which is what a sign-in card can connect; otherwise null. */
  find(app: string, signal: AbortSignal): Promise<MarketplaceConnector | null>;
};

const FULL_SHA = /^[a-f0-9]{40}$/;
/** The files that declare a plugin and its MCP servers, which is all a connector needs. */
const CONNECTOR_FILES = [
  "plugin.json",
  ".cursor-plugin/plugin.json",
  ".grok-plugin/plugin.json",
  "mcp.json",
  ".mcp.json",
];

/**
 * The servers a plugin pinned to a commit declares, read from only its declaration files at that
 * commit. A plugin that also bundles hundreds of skills is more than a full preview fetches, and
 * none of them matter here. Null for a plugin pinned to no commit.
 */
async function pinnedServers(source: string, read: PluginTextReader, signal: AbortSignal) {
  const ref = parsePluginSource(source);
  if (!ref.ref || !FULL_SHA.test(ref.ref)) return null;
  const repo = new URL(ref.gitUrl).pathname;
  const dir = ref.subdir ? `${ref.subdir}/` : "";
  const files = await Promise.all(
    CONNECTOR_FILES.map(async (path) => {
      try {
        const url = `https://raw.githubusercontent.com${repo}/${ref.ref}/${dir}${path}`;
        return [{ path, content: await read(url, 256_000, signal) }];
      } catch (error) {
        // Most of these files are optional; only a confirmed missing one is left out.
        if (error instanceof Error && error.message === "Request failed: HTTP 404") return [];
        throw error;
      }
    }),
  );
  return parsePluginDirectory({ files: files.flat(), resolvedSha: ref.ref }).mcpServers;
}

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function named(entry: PluginMarketplaceEntry, app: string): boolean {
  const wanted = key(app);
  return [entry.name, entry.displayName].some((name) => key(name) === wanted);
}

export function createMarketplaceConnectors(
  options: { read?: PluginTextReader; fetcher?: PluginRepoFetcher } = {},
): MarketplaceConnectors {
  const read = options.read ?? publicRead;
  const marketplace = createPluginMarketplace(read);
  return {
    async find(app, signal) {
      const { entries } = await marketplace.catalog(app);
      const entry = entries.find((candidate) => candidate.hasConnector && named(candidate, app));
      if (!entry) return null;
      // The commit the listing pins, or the registry's current one for a listing that pins none,
      // as installing it from the marketplace would.
      const servers =
        (await pinnedServers(entry.source, read, signal)) ??
        (await previewPluginInstall({ source: entry.source, fetcher: options.fetcher, signal }))
          .mcpServers;
      const [server, ...more] = servers;
      if (!server || more.length || Object.keys(server.headers).length) return null;
      return {
        name: entry.displayName,
        description: entry.description,
        logo: entry.logo,
        server,
      };
    },
  };
}
