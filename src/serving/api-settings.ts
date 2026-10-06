import { createEmbedder, LOCAL_EMBEDDERS, scoreScale } from "../indexing/embedder.ts";
import type { Config } from "../shared/config.ts";
import { errorMessage } from "../shared/errors.ts";
import { Refusal } from "../shared/refusal.ts";
import {
  applyChanges,
  applySettings,
  parseChanges,
  type SettingsChanges,
  writeServerSettings,
} from "../shared/server-settings.ts";
import type { Ragdown } from "./engine.ts";
import { type ApiRequest, allow, assertWritable, json, readJsonObject } from "./http-io.ts";

/**
 * The settings the web UI shows, read from the environment at start. Served unauthenticated with
 * the status, so only tuning numbers belong here: never the token, a key, or an endpoint URL.
 */
export function publicSettings(config: Config) {
  return {
    embedder: config.embedder,
    watch: config.watch,
    text_limit: config.textLimit,
    hook: {
      top_k: config.hook.topK,
      min_score: config.hook.minScore,
      min_ratio: config.hook.minRatio,
      max_chars: config.hook.maxChars,
      // What an unrelated prompt scores on this embedder, so the UI can say a floor is too low.
      unrelated_score: scoreScale(config.embedder)?.unrelated ?? null,
    },
    // The two layers under the values above: what the UI saved, and what applies without it.
    saved: config.saved,
    env: {
      embedder: config.env.embedder,
      watch: config.env.watch,
      text_limit: config.env.textLimit,
      hook: {
        top_k: config.env.hook.topK,
        min_score: config.env.hook.minScore,
        min_ratio: config.env.hook.minRatio,
        max_chars: config.env.hook.maxChars,
      },
    },
    // The embedders a form can offer, each with the floor that goes with it.
    embedders: Object.fromEntries(
      [...new Set([...LOCAL_EMBEDDERS, config.embedder, config.env.embedder])].map((name) => [
        name,
        {
          min_score: scoreScale(name)?.minScore ?? null,
          unrelated_score: scoreScale(name)?.unrelated ?? null,
        },
      ]),
    ),
  };
}

/** One settings change at a time: two embedder changes at once would each rebuild the index. */
let settingsChange: Promise<unknown> = Promise.resolve();

/**
 * Save a change to the server settings and put it into effect. The new embedder is loaded before
 * anything is saved, so a name that cannot be loaded changes nothing.
 */
async function changeSettings(rag: Ragdown, config: Config, changes: SettingsChanges) {
  const saved = applyChanges(config.saved, changes);
  const embedder = saved.embedder ?? config.env.embedder;
  if (embedder !== config.embedder) {
    if (rag.role !== "primary") {
      throw new Refusal(
        409,
        "this process only reads the index: change the embedder where it is built",
      );
    }
    const loaded = await createEmbedder({ ...config, embedder }).catch((error: unknown) => {
      throw new Refusal(400, errorMessage(error));
    });
    await writeServerSettings(config.docsDir, saved);
    applySettings(config, saved);
    await rag.switchEmbedder(loaded);
  } else {
    await writeServerSettings(config.docsDir, saved);
    applySettings(config, saved);
  }
  rag.setWatch();
}

/** `PATCH /api/settings`: save the server settings and answer with what now applies. */
export async function handleSettings(request: ApiRequest): Promise<void> {
  const { rag, config, req, res } = request;
  allow(request, "PATCH");
  assertWritable(config);
  const changes = parseChanges(await readJsonObject(req));
  const change = settingsChange.then(() => changeSettings(rag, config, changes));
  settingsChange = change.catch(() => undefined);
  await change;
  json(res, 200, { settings: publicSettings(config) });
}
