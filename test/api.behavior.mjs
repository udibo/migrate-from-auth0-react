import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freePort, start } from "./servers.mjs";

// None of these requests reaches Auth0: each is refused, or answered, before
// the API reads the tenant's metadata. A request that carries a token needs
// the tenant and is tested in e2e/ against it.
const TENANT = { AUTH0_DOMAIN: "tenant.invalid", AUTH0_AUDIENCE: "https://api.example.test" };

describe("the API server's configuration", { timeout: 20_000 }, () => {
  for (const [name, env] of [
    ["no AUTH0_DOMAIN", { AUTH0_AUDIENCE: TENANT.AUTH0_AUDIENCE }],
    ["no AUTH0_AUDIENCE", { AUTH0_DOMAIN: TENANT.AUTH0_DOMAIN }],
    ["the placeholder audience", { ...TENANT, AUTH0_AUDIENCE: "{yourApiIdentifier}" }],
  ]) {
    test(`exits instead of serving with ${name}, and reports success`, async () => {
      const api = await start("api-server.js", { ...env, API_PORT: String(await freePort()) });
      await api.stop();
      assert.equal(api.exitCode, 0);
      assert.match(api.output(), /Exiting API Server: Please make sure AUTH0_DOMAIN and AUTH0_AUDIENCE/);
    });
  }
});

describe("the API server", { timeout: 20_000 }, () => {
  let api;
  let origin;

  before(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    api = await start("api-server.js", { ...TENANT, API_PORT: String(port) });
    assert.equal(api.exitCode, null, api.output());
  });

  after(() => api.stop());

  test("refuses a request without a token with 401 and a Bearer challenge", async () => {
    const response = await fetch(`${origin}/api/external`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Bearer realm="api"/);
  });

  test("refuses an Authorization header that is not Bearer with 400", async () => {
    const response = await fetch(`${origin}/api/external`, { headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("www-authenticate"), /^Bearer realm="api"/);
  });

  test("answers a refusal with the error's stack trace, as Express does outside production", async () => {
    const body = await (await fetch(`${origin}/api/external`)).text();
    assert.match(body, /UnauthorizedError: Unauthorized<br> &nbsp; &nbsp;at /);
  });

  test("names only the app's origin, http://localhost:3000 by default, in CORS", async () => {
    for (const requester of ["http://localhost:3000", "https://elsewhere.example"]) {
      const response = await fetch(`${origin}/api/external`, {
        method: "OPTIONS",
        headers: { Origin: requester, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    }
  });

  test("serves nothing but /api/external", async () => {
    const response = await fetch(`${origin}/api/private`);
    assert.equal(response.status, 404);
  });
});

describe("the API server in production", { timeout: 20_000 }, () => {
  test("answers a refusal without the stack trace", async () => {
    const port = await freePort();
    const api = await start("api-server.js", { ...TENANT, API_PORT: String(port), NODE_ENV: "production" });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/external`);
      assert.equal(response.status, 401);
      const body = await response.text();
      assert.doesNotMatch(body, / at /);
      assert.match(body, /Unauthorized/);
    } finally {
      await api.stop();
    }
  });
});

describe("the API server with APP_BASE_URL", { timeout: 20_000 }, () => {
  test("names that origin in CORS instead", async () => {
    const port = await freePort();
    const api = await start("api-server.js", { ...TENANT, API_PORT: String(port), APP_BASE_URL: "https://app.example.test" });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/external`, {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.test", "Access-Control-Request-Method": "GET" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.test");
    } finally {
      await api.stop();
    }
  });
});
