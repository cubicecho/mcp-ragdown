import { hostname } from "node:os";
import {
  type AdvertisedEndpoint,
  airIdentifier,
  createServerCard,
  type KeyValueInput,
} from "@cubicecho/mcp-discovery";
import { listFolders } from "../folders/folder-settings.ts";
import type { Config } from "../shared/config.ts";
import { VERSION } from "./mcp-tools.ts";

/** The reverse-DNS namespace every card's name starts with; the host's slug is appended to it. */
const CARD_NAMESPACE = "io.github.cubicecho.ragdown";

/** The project's source, shown on every card. */
const REPOSITORY = { url: "https://github.com/cubicecho/mcp-ragdown", source: "github" } as const;

/** Bare `/mcp`, the endpoint over every folder with MCP on. */
const ROOT_PATH = "/mcp";

/** The root endpoint's name on its card. Folders' names carry `FOLDER_PREFIX`, so none is this. */
const ROOT_NAME = "root";

/** What a folder's endpoint name starts with. */
const FOLDER_PREFIX = "f-";

/** A hostname's slug when nothing is left of it once cut down. */
const FALLBACK_HOST_SLUG = "host";

/** A folder name's slug when nothing is left of it once cut down. */
const FALLBACK_FOLDER_SLUG = "folder";

/** The longest title a Server Card may carry, in characters. */
const CARD_TITLE_MAX_CHARS = 100;

/** The header a client must send when bearer auth is on; its value is never in the card. */
const AUTH_HEADER: KeyValueInput = {
  name: "Authorization",
  description: "Bearer <token>, the server's RAGDOWN_TOKEN",
  isRequired: true,
  isSecret: true,
};

/**
 * Text cut down to what a card name and a `urn:air` id allow: lowercase letters, digits, hyphens.
 *
 * @param text - A name.
 * @param fallback - What to answer when nothing is left.
 * @returns E.g. `my-notes` for `My notes`.
 */
function slugOf(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/**
 * A hostname's first label as a slug, which keeps two servers' card names apart on one network.
 *
 * @param name - The machine's hostname.
 * @returns E.g. `nas` for `NAS`, `my-box` for `my_box.lan`, and `host` when nothing is left.
 */
export function hostSlug(name: string): string {
  const [first = ""] = name.split(".");
  return slugOf(first, FALLBACK_HOST_SLUG);
}

/**
 * The MCP endpoints `serve` makes discoverable: each folder with MCP on, and bare `/mcp` while the
 * root is served.
 *
 * @param config - The running config, read on every call so a settings change shows at once.
 * @param [host] - The machine's hostname, which keeps card names apart on a shared network.
 * @returns The endpoints, each with a card builder that names the URL the request came in on.
 *
 * @remarks
 * A subfolder is reachable at `/mcp/<folder>/<sub>` but is not listed: it is a narrower view of a
 * folder already listed. Two folders whose names cut down to the same slug get `-2`, `-3` after it.
 */
export async function discoveryEndpoints(
  config: Config,
  host: string = hostname(),
): Promise<AdvertisedEndpoint[]> {
  const slug = hostSlug(host);
  const isAuthOn = config.http.secureLocalNet === false;
  const headers = isAuthOn ? [AUTH_HEADER] : [];
  const endpoint = (
    path: string,
    name: string,
    title: string,
    description: string,
  ): AdvertisedEndpoint => ({
    path,
    identifier: airIdentifier(`${slug}.ragdown`, name),
    card: ({ endpointUrl }) =>
      createServerCard({
        name: `${CARD_NAMESPACE}.${slug}/${name}`,
        version: VERSION,
        title: title.slice(0, CARD_TITLE_MAX_CHARS),
        description,
        repository: REPOSITORY,
        remotes: [{ type: "streamable-http", url: endpointUrl, headers }],
      }),
  });

  const taken = new Set<string>();
  const uniqueName = (base: string): string => {
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) {
      name = `${base}-${suffix}`;
    }
    taken.add(name);
    return name;
  };
  const folders = (await listFolders(config.docsDir))
    .filter((folder) => folder.mcp)
    .map((folder) =>
      endpoint(
        `${ROOT_PATH}/${encodeURIComponent(folder.name)}`,
        uniqueName(`${FOLDER_PREFIX}${slugOf(folder.name, FALLBACK_FOLDER_SLUG)}`),
        folder.title,
        "A folder of Markdown documents, searched over MCP.",
      ),
    );
  if (config.rootMcp === false) {
    return folders;
  }
  const root = endpoint(
    ROOT_PATH,
    ROOT_NAME,
    `MCP Ragdown on ${host}`,
    "Every folder of Markdown documents with MCP on, searched over MCP.",
  );
  return [root, ...folders];
}
