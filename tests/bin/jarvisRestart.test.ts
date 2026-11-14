import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "jarvis-restart.sh");

// `bun` and `curl` are shims on PATH: each call is logged, and FAIL_ON names the
// `bun` call that fails, so nothing real is typechecked, tested, built or restarted.
let dir: string;
let repo: string;
let log: string;
let shims: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-restart-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, "web"), { recursive: true });
  log = join(dir, "calls.log");
  shims = join(dir, "shims");
  mkdirSync(shims);
  writeFileSync(
    join(shims, "bun"),
    `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo '{"reason":"x"}'; exit 0; fi
echo "bun $* @$(basename "$PWD")" >> "${log}"
[ -n "\${FAIL_ON:-}" ] && [ "$*" = "$FAIL_ON" ] && exit 1
exit 0
`,
  );
  writeFileSync(join(shims, "curl"), `#!/usr/bin/env bash\necho "curl" >> "${log}"\necho '{"ok":true}'\n`);
  chmodSync(join(shims, "bun"), 0o755);
  chmodSync(join(shims, "curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], failOn = "") =>
  Bun.spawnSync(["bash", script, ...args], {
    env: {
      PATH: `${shims}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      JARVIS_REPO: repo,
      FAIL_ON: failOn,
    },
  });

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("bin/jarvis-restart.sh", () => {
  test("rebuilds the dashboard after the checks and before asking for the restart", () => {
    const res = run([]);
    expect(res.exitCode).toBe(0);
    expect(calls()).toEqual(["bun run typecheck @repo", "bun test @repo", "bun run build:web @repo", "curl"]);
  });

  test("a failed dashboard build refuses the restart", () => {
    const res = run([], "run build:web");
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("REFUSING TO RESTART: dashboard build failed");
    expect(calls()).not.toContain("curl");
  });

  test("--check-only builds into a throwaway folder and never touches web/dist or restarts", () => {
    const res = run(["--check-only"]);
    expect(res.exitCode).toBe(0);
    const built = calls().find((c) => c.startsWith("bun x vite build"));
    expect(built).toMatch(/--outDir \S*jarvis-web\.\S+ --emptyOutDir @web$/);
    expect(calls()).not.toContain("bun run build:web @repo");
    expect(calls()).not.toContain("curl");
  });

  test("--check-only fails when the dashboard does not build", () => {
    const res = run(["--check-only"], "install");
    expect(res.exitCode).toBe(1);
    expect(calls()).not.toContain("curl");
  });
});
