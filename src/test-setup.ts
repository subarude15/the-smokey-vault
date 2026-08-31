import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Preloaded by `npm test` before any test module is evaluated, so `db.ts` opens a
 * throwaway database instead of the working copy in ./data. Several suites truncate
 * whole tables, which would otherwise wipe real bar data on a dev machine.
 *
 * Everything derived from `dirname(dbPath)` — the images and gallery folders — lands
 * inside the same temp directory and is removed with it.
 */
const scratch = mkdtempSync(join(tmpdir(), "smokey-test-"));
process.env.DB_PATH = join(scratch, `smokey-test-${Date.now()}.db`);
/** HTTP inject tests import the Fastify app; never bind a port or start workers during npm test. */
process.env.SMOKEY_TEST_NO_LISTEN = "1";

process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A stray temp directory is not worth failing the run over.
  }
});
