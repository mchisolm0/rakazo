import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import type {
  PluginMcpServerEntry,
  PluginRepoFetcher,
  PluginTextReader,
} from "./plugin-connectors.js";
import { previewPluginInstall } from "./plugin-connectors.js";
import { createPluginMarketplace } from "./plugin-marketplace.js";

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

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function named(entry: PluginMarketplaceEntry, app: string): boolean {
  const wanted = key(app);
  return [entry.name, entry.displayName].some((name) => key(name) === wanted);
}

export function createMarketplaceConnectors(
  options: { read?: PluginTextReader; fetcher?: PluginRepoFetcher } = {},
): MarketplaceConnectors {
  const marketplace = createPluginMarketplace(options.read);
  return {
    async find(app, signal) {
      const { entries } = await marketplace.catalog(app);
      const entry = entries.find((candidate) => candidate.hasConnector && named(candidate, app));
      if (!entry) return null;
      // The preview reads the commit the listing pins, never the plugin's latest.
      const plugin = await previewPluginInstall({
        source: entry.source,
        fetcher: options.fetcher,
        signal,
      });
      const [server, ...more] = plugin.mcpServers;
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
