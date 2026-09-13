import type { Config, RemoteHookConfig } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { NoPrimaryError, request } from "./primary.ts";

/** The fields of a Claude Code hook event this hook reads. */
interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
}

/**
 * Handle one Claude Code `UserPromptSubmit` event: find notes related to the prompt and return
 * the hook output that adds them to the model's context, or undefined to add nothing.
 *
 * The primary server answers over its socket in milliseconds, with the model already loaded. With
 * no primary running this process becomes one for the length of the call — loading the model and
 * syncing the folder — which is slower but means the hook works on its own.
 *
 * @param deps.start injectable for tests; the real one loads the embedder.
 */
export async function runHook(
  event: HookEvent,
  config: Config,
  deps: { start: (config: Config) => Promise<Ragdown> } = { start: startEngine },
): Promise<string | undefined> {
  if (event.hook_event_name && event.hook_event_name !== "UserPromptSubmit") return undefined;
  const prompt = event.prompt ?? "";
  let context: string | null | undefined;
  try {
    const reply = (await request(
      config.socketPath,
      { op: "context", prompt, session_id: event.session_id },
      config.hook.timeoutMs,
    )) as { context: string | null };
    context = reply.context;
  } catch (error) {
    if (!(error instanceof NoPrimaryError)) throw error;
    const rag = await deps.start(config);
    try {
      context = await rag.context(prompt, event.session_id);
    } finally {
      await rag.close();
    }
  }
  return context ? hookOutput(context) : undefined;
}

/**
 * Imported on demand: loading LanceDB and ONNX Runtime costs a few hundred milliseconds, and the
 * common case — a primary is running — needs neither.
 */
async function startEngine(config: Config): Promise<Ragdown> {
  const { Ragdown } = await import("./engine.ts");
  return Ragdown.start(config);
}

/**
 * The same, answered by a server over HTTP (`RAGDOWN_URL`), such as one in a container. There is no
 * in-process fallback: the docs folder is wherever that server is.
 */
export async function runRemoteHook(
  event: HookEvent,
  remote: RemoteHookConfig,
): Promise<string | undefined> {
  if (event.hook_event_name && event.hook_event_name !== "UserPromptSubmit") return undefined;
  const response = await fetch(`${remote.url}/api/context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(remote.token ? { authorization: `Bearer ${remote.token}` } : {}),
    },
    body: JSON.stringify({ prompt: event.prompt ?? "", session_id: event.session_id }),
    signal: AbortSignal.timeout(remote.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${remote.url} answered ${response.status}: ${await response.text()}`);
  }
  const { context } = (await response.json()) as { context: string | null };
  return context ? hookOutput(context) : undefined;
}

function hookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  });
}

/** Read the event from stdin, print the hook output. A failure is logged, never fatal to the prompt. */
export async function hookMain(target: Config | RemoteHookConfig): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as HookEvent;
    const output =
      "url" in target ? await runRemoteHook(event, target) : await runHook(event, target);
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    // Exit 0 either way: a broken index must not block the user from sending a prompt.
    console.error(`[ragdown hook] ${errorMessage(error)}`);
  }
}
