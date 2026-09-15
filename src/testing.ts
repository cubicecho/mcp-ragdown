import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, loadConfig } from "./config.ts";

/**
 * A docs folder and data dir under a fresh temp dir, with the hash embedder so tests need no model.
 * Not a test file itself: shared by the `*.test.ts` files.
 */
export async function tempSetup(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ragdown-test-"));
  const docsDir = join(root, "docs");
  await mkdir(docsDir);
  const config: Config = loadConfig({
    RAGDOWN_DOCS_DIR: docsDir,
    RAGDOWN_DATA_DIR: join(root, "data"),
    RAGDOWN_MODELS: join(root, "models"),
    RAGDOWN_EMBEDDER: "hash",
    RAGDOWN_WATCH: "false",
    RAGDOWN_HOOK_MIN_SCORE: "0.2",
    ...env,
  });
  return {
    root,
    docsDir,
    config,
    write: async (path: string, text: string) => {
      await mkdir(dirname(join(docsDir, path)), { recursive: true });
      await writeFile(join(docsDir, path), text);
    },
    // LanceDB can still be writing an index file as the test ends, and removing a directory it is
    // filling fails with ENOTEMPTY. The retries wait it out instead of failing the test.
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** Poll until `check` returns true or `timeoutMs` passes. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((done) => setTimeout(done, 50));
  }
}
