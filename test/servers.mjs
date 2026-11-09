import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

/** A port the system reports free; the sample's servers take a port, not 0. */
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

/**
 * Every variable the sample reads, set empty. api-server.js loads .env.local
 * with dotenv, which never overrides a variable already set, so a developer's
 * filled .env.local cannot reach a test.
 */
export const UNSET = Object.fromEntries(
  ["OAUTH_ISSUER", "OAUTH_CLIENT_ID", "OAUTH_AUDIENCE", "API_BASE_URL", "APP_BASE_URL", "API_PORT", "SERVER_PORT", "NODE_ENV"].map(
    (name) => [name, ""],
  ),
);

/**
 * Runs `node <script>` (relative to the repository root) in `cwd` with `env`
 * laid over a minimal environment, resolving once it prints `ready` or exits.
 * Pass `isolate: false` to leave the sample's variables unset, so dotenv can
 * fill them.
 */
export async function start(script, env, { ready = /listening on port/i, cwd = root, isolate = true } = {}) {
  const child = spawn(process.execPath, [join(root, script)], {
    cwd,
    env: { PATH: process.env.PATH, ...(isolate ? UNSET : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = once(child, "exit").then(([code]) => ({ code }));
  const listening = new Promise((resolve) => {
    child.stdout.on("data", () => {
      if (ready.test(output)) resolve({ code: null });
    });
  });
  const outcome = await Promise.race([listening, exited]);
  return {
    child,
    exitCode: outcome.code,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    },
  };
}
