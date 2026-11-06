import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { freePort, root, start } from "./servers.mjs";

const built = join(root, "dist", "index.html");

describe("the production server for the built app", { timeout: 20_000 }, () => {
  let server;
  let origin;

  before(async () => {
    assert.ok(existsSync(built), "run npm run build first; npm run test:behavior does");
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = await start("server.js", { SERVER_PORT: String(port) });
    assert.equal(server.exitCode, null, server.output());
  });

  after(() => server.stop());

  for (const path of ["/", "/profile", "/external-api", "/no/such/page"]) {
    test(`answers ${path} with the app's page, so the browser's router takes it`, async () => {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), readFileSync(built, "utf8"));
    });
  }

  test("serves the built script the page loads", async () => {
    const page = readFileSync(built, "utf8");
    const script = page.match(/<script type="module" crossorigin src="([^"]+)"/)?.[1];
    assert.ok(script, "the built page names its script");
    const response = await fetch(origin + script);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
  });

  test("sends no Content-Security-Policy, as upstream turns it off", async () => {
    const response = await fetch(origin + "/");
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});
