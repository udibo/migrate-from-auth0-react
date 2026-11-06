import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
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
 * Runs `node <script>` from the repository root with `env` laid over a
 * minimal environment, resolving once it prints `ready` or exits.
 */
export async function start(script, env, ready = /listening on port/i) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
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
