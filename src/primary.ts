import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { errorMessage } from "./errors.ts";

/**
 * One process per index is the primary: it writes the index and watches the folder. Every other
 * server on the same index — a second Claude Code window's stdio server, say — is a reader that
 * forwards syncs to it.
 *
 * Holding the unix socket *is* the lock, so the lock and the endpoint cannot disagree, and a
 * crashed primary leaves nothing that blocks the next one: a socket file nobody listens on is
 * refused on connect and taken over. Two processes taking over the same stale socket in the same
 * instant can both win; the cost is two writers until one exits, which LanceDB's optimistic
 * commits survive.
 */

export type Handler = (request: Record<string, unknown>) => Promise<unknown>;

/** Raised when there is no primary to talk to, as distinct from a primary that failed. */
class NoPrimaryError extends Error {}

/**
 * Try to become the primary.
 *
 * @returns the listening server, or undefined when a live primary already holds the socket.
 */
export async function claimSocket(path: string, handler: Handler): Promise<Server | undefined> {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer((socket) => serve(socket, handler));
  try {
    await listen(server, path);
    return server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
  if (await isAlive(path)) return undefined;
  await unlink(path).catch(() => undefined);
  try {
    await listen(server, path);
    return server;
  } catch (error) {
    // Lost the race for the stale socket to another process, which is now the primary.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
    throw error;
  }
}

/**
 * Send one request to the primary and wait for its answer.
 *
 * @throws NoPrimaryError when nothing listens on the socket; any other error is the primary's.
 */
export function request(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the primary did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (data) => {
      buffer += data;
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error ?? "the primary reported an error"));
      } catch (error) {
        reject(new Error(`unreadable reply from the primary: ${errorMessage(error)}`));
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        reject(new NoPrimaryError(`no primary is listening on ${path}`));
      } else reject(error);
    });
  });
}

function serve(socket: Socket, handler: Handler): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    buffer += data;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    socket.removeAllListeners("data");
    void (async () => {
      let reply: unknown;
      try {
        reply = { ok: true, result: await handler(JSON.parse(line) as Record<string, unknown>) };
      } catch (error) {
        reply = { ok: false, error: errorMessage(error) };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    })();
  });
  socket.on("error", (error) => console.error(`[primary] client socket: ${errorMessage(error)}`));
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      // The socket answers with the contents of the notes; in a shared /tmp that is nobody else's.
      chmod(path, 0o600).then(resolve, reject);
    });
  });
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}
