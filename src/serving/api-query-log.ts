import { summarize } from "../usage/usage-summary.ts";
import { type ApiRequest, allow, json } from "./http-io.ts";

/**
 * `GET /api/query-log`: what the query log says about search, summed up for the web UI's Usage
 * tab, with whether the log is on. `DELETE` empties it. The log is not documents, so a read-only
 * server may clear it.
 */
export async function handleQueryLog(request: ApiRequest): Promise<void> {
  const { rag, config, method, res } = request;
  allow(request, "GET", "DELETE");
  if (method === "DELETE") {
    await rag.queryLog.clear();
  }
  json(res, 200, {
    enabled: config.queryLog,
    summary: summarize(await rag.queryLog.records(), config.hook.minScore),
  });
}
