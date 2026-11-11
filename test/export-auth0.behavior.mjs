import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { gzipSync } from "node:zlib";

import { carriesPasswordHash, main as transformMain, parseAuth0Export, toImportRecord, transformExport } from "../scripts/auth0-to-udibo.mjs";
import { describeRecords } from "../scripts/describe-export.mjs";
import { Auth0Refusal, EXPORT_FIELDS, exportAuth0Users, main as exportMain } from "../scripts/export-auth0-users.mjs";
import { withInterrupts, writePrivateNdjson } from "../scripts/private-file.mjs";

const DOMAIN = "tenant.example.test";
const ADA = {
  user_id: "auth0|a1b2c3",
  email: "ada@example.test",
  email_verified: true,
  name: "Ada Lovelace",
  given_name: "Ada",
  family_name: "Lovelace",
  nickname: "ada",
  identities: [{ connection: "Username-Password-Authentication", user_id: "a1b2c3", provider: "auth0", isSocial: false }],
  app_metadata: { roles: ["admin"] },
  user_metadata: { theme: "light" },
};
const ALAN = {
  user_id: "google-oauth2|1035",
  email: "alan@example.test",
  email_verified: true,
  name: "Alan Turing",
  nickname: "alan",
  identities: [{ connection: "google-oauth2", user_id: "1035", provider: "google-oauth2", isSocial: true }],
  app_metadata: {},
  user_metadata: {},
};

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "auth0-export-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for the Management API, recording each call. `routes` answers by method and path. */
function fakeAuth0(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.host === DOMAIN ? u.pathname : u.href}`;
    calls.push({ key, url: u, init });
    const route = routes[key];
    if (!route) return json({ statusCode: 404, error: "Not Found" }, 404);
    return typeof route === "function" ? route(u, init, calls) : route.clone();
  };
  return { fetch, calls };
}

const tokenRoute = { "POST /oauth/token": json({ access_token: "management-token", token_type: "Bearer" }) };
const options = (fetch, extra = {}) => ({ domain: DOMAIN, clientId: "export-client", clientSecret: "export-secret", fetch, pollIntervalMs: 1, ...extra });
const lines = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const mode = (file) => fs.statSync(file).mode & 0o777;

describe("exporting the Auth0 tenant's users", () => {
  test("asks for a Management API token, runs the export job, and writes its records with mode 0600", async () => {
    const gz = gzipSync(Buffer.from([ADA, ALAN].map((u) => JSON.stringify(u)).join("\n") + "\n"));
    let polls = 0;
    const auth0 = fakeAuth0({
      ...tokenRoute,
      "POST /api/v2/jobs/users-exports": json({ id: "job_1", status: "pending" }, 201),
      "GET /api/v2/jobs/job_1": () => json(++polls < 2 ? { id: "job_1", status: "processing" } : { id: "job_1", status: "completed", location: "https://download.example.test/export.json.gz" }),
      "GET https://download.example.test/export.json.gz": () => new Response(gz),
    });
    const file = join(dir, "users.ndjson");

    const result = await exportAuth0Users(file, options(auth0.fetch));

    assert.deepEqual(result, { count: 2, source: "export job", jobRefusal: undefined });
    assert.deepEqual(lines(file), [ADA, ALAN]);
    assert.equal(mode(file), 0o600);
    assert.equal(fs.existsSync(`${file}.partial`), false);
    const token = JSON.parse(auth0.calls[0].init.body);
    assert.deepEqual(token, { grant_type: "client_credentials", client_id: "export-client", client_secret: "export-secret", audience: `https://${DOMAIN}/api/v2/` });
    const job = auth0.calls.find((c) => c.key === "POST /api/v2/jobs/users-exports");
    assert.equal(job.init.headers.authorization, "Bearer management-token");
    assert.deepEqual(JSON.parse(job.init.body), { format: "json", fields: EXPORT_FIELDS.map((name) => ({ name })) });
    assert.equal(polls, 2);
  });

  test("names the connection when one is given", async () => {
    const auth0 = fakeAuth0({
      ...tokenRoute,
      "POST /api/v2/jobs/users-exports": json({ id: "job_2", status: "completed", location: "https://download.example.test/e.gz" }, 201),
      "GET https://download.example.test/e.gz": () => new Response(gzipSync(Buffer.from(""))),
    });
    await exportAuth0Users(join(dir, "users.ndjson"), options(auth0.fetch, { connectionId: "con_abcdefghijklmnop" }));
    const job = auth0.calls.find((c) => c.key === "POST /api/v2/jobs/users-exports");
    assert.equal(JSON.parse(job.init.body).connection_id, "con_abcdefghijklmnop");
  });

  for (const [refused, routes] of [
    ["the job itself", { "POST /api/v2/jobs/users-exports": json({ statusCode: 403, error: "Forbidden", message: "Feature not available on this plan", errorCode: "operation_not_supported" }, 403) }],
    [
      "the job's status",
      {
        "POST /api/v2/jobs/users-exports": json({ id: "job_3", status: "pending" }, 201),
        "GET /api/v2/jobs/job_3": json({ statusCode: 403, error: "Forbidden", message: "Insufficient scope, expected any of: create:users", errorCode: "insufficient_scope" }, 403),
      },
    ],
  ]) {
    test(`reads the users page by page from GET /api/v2/users when Auth0 refuses ${refused}, and says why`, async () => {
      const page0 = Array.from({ length: 100 }, (_, i) => ({ ...ADA, user_id: `auth0|${i}`, email: `user${i}@example.test` }));
      const auth0 = fakeAuth0({
        ...tokenRoute,
        ...routes,
        "GET /api/v2/users": (u) => json(u.searchParams.get("page") === "0" ? page0 : [ALAN]),
      });
      const file = join(dir, "users.ndjson");

      const result = await exportAuth0Users(file, options(auth0.fetch));

      assert.equal(result.source, "users API");
      assert.equal(result.count, 101);
      assert.match(result.jobRefusal, /Auth0 answered 403 \((operation_not_supported|insufficient_scope): /);
      assert.equal(lines(file).length, 101);
      const pages = auth0.calls.filter((c) => c.key === "GET /api/v2/users").map((c) => [c.url.searchParams.get("page"), c.url.searchParams.get("per_page")]);
      assert.deepEqual(pages, [["0", "100"], ["1", "100"]]);
    });
  }

  test("writes nothing when the token is refused", async () => {
    const auth0 = fakeAuth0({ "POST /oauth/token": json({ error: "access_denied", error_description: "Unauthorized" }, 401) });
    const file = join(dir, "users.ndjson");
    await assert.rejects(exportAuth0Users(file, options(auth0.fetch)), (error) => error instanceof Auth0Refusal && error.step === "token" && error.status === 401);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("leaves no file when the users API fails part way", async () => {
    const auth0 = fakeAuth0({
      ...tokenRoute,
      "POST /api/v2/jobs/users-exports": json({ statusCode: 403 }, 403),
      "GET /api/v2/users": (u) => (u.searchParams.get("page") === "0" ? json(Array.from({ length: 100 }, () => ADA)) : json({ statusCode: 429, error: "Too Many Requests" }, 429)),
    });
    const file = join(dir, "users.ndjson");
    await assert.rejects(exportAuth0Users(file, options(auth0.fetch)), /users API: Auth0 answered 429/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("stops polling and writes nothing when interrupted", async () => {
    const controller = new AbortController();
    const auth0 = fakeAuth0({
      ...tokenRoute,
      "POST /api/v2/jobs/users-exports": json({ id: "job_4", status: "pending" }, 201),
      "GET /api/v2/jobs/job_4": () => {
        controller.abort("SIGINT");
        return json({ id: "job_4", status: "processing" });
      },
    });
    await assert.rejects(exportAuth0Users(join(dir, "users.ndjson"), options(auth0.fetch, { signal: controller.signal, pollIntervalMs: 50 })));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("refuses to start without the domain or the application's credentials", async () => {
    await assert.rejects(exportAuth0Users(join(dir, "u.ndjson"), { domain: DOMAIN, clientId: "x" }), /Missing clientSecret/);
    const stderr = [];
    const original = console.error;
    console.error = (message) => stderr.push(String(message));
    try {
      assert.equal(await exportMain([join(dir, "u.ndjson")], { AUTH0_DOMAIN: DOMAIN }), 1);
      assert.equal(await exportMain([], {}), 2);
    } finally {
      console.error = original;
    }
    assert.match(stderr[0], /Missing clientId/);
  });
});

describe("the private file", () => {
  test("refuses a file, a partial file or a link already in place, and leaves them as they were", async () => {
    const file = join(dir, "users.ndjson");
    fs.writeFileSync(file, "keep");
    await assert.rejects(writePrivateNdjson([ADA], file), { code: "EEXIST" });
    assert.equal(fs.readFileSync(file, "utf8"), "keep");

    const other = join(dir, "other.ndjson");
    const target = join(dir, "target");
    fs.writeFileSync(target, "target", { mode: 0o644 });
    fs.symlinkSync(target, `${other}.partial`);
    await assert.rejects(writePrivateNdjson([ADA], other), { code: "EEXIST" });
    assert.equal(fs.readFileSync(target, "utf8"), "target");
    assert.equal(mode(target), 0o644);
  });

  test("leaves a file that appears while the records are written as it was", async () => {
    const file = join(dir, "users.ndjson");
    async function* records() {
      yield ADA;
      fs.writeFileSync(file, "appeared");
      yield ALAN;
    }
    await assert.rejects(writePrivateNdjson(records(), file), { code: "EEXIST" });
    assert.equal(fs.readFileSync(file, "utf8"), "appeared");
    assert.equal(fs.existsSync(`${file}.partial`), false);
  });

  for (const [signal, exitCode] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
    test(`stops on ${signal}, exits ${exitCode} and removes the partial file`, async () => {
      const file = join(dir, "users.ndjson");
      let interrupted = false;
      const code = await withInterrupts(async (abort) => {
        async function* records() {
          yield ADA;
          process.emit(signal, signal);
          yield ALAN;
        }
        return writePrivateNdjson(records(), file, abort);
      }, () => (interrupted = true));
      assert.equal(code, exitCode);
      assert.equal(interrupted, true);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  }
});

describe("turning Auth0 records into Udibo import records", () => {
  test("maps a database user by the recipe's mapping, with no password", () => {
    assert.deepEqual(toImportRecord(ADA), {
      email: "ada@example.test",
      emailVerified: true,
      username: "ada",
      firstName: "Ada",
      lastName: "Lovelace",
      displayName: "Ada Lovelace",
      metadata: { roles: ["admin"] },
      userMetadata: { theme: "light" },
    });
  });

  test("links a social user's identities and skips the database identity", () => {
    assert.deepEqual(toImportRecord(ALAN), {
      email: "alan@example.test",
      emailVerified: true,
      username: "alan",
      displayName: "Alan Turing",
      identities: [{ provider: "google-oauth2", subject: "1035" }],
    });
  });

  test("an unverified email stays unverified", () => {
    assert.equal(toImportRecord({ ...ADA, email_verified: false }).emailVerified, false);
    assert.equal(toImportRecord({ ...ADA, email_verified: undefined }).emailVerified, false);
  });

  test("drops a password hash a record carries, and counts it", async () => {
    const withHashes = [
      { ...ADA, custom_password_hash: { algorithm: "bcrypt", hash: { value: "$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123" } } },
      { ...ALAN, password_hash: "$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123" },
      ADA,
    ];
    assert.deepEqual(withHashes.map(carriesPasswordHash), [true, true, false]);
    for (const user of withHashes) assert.equal("legacyCredential" in toImportRecord(user), false);

    const input = join(dir, "export.ndjson");
    fs.writeFileSync(input, withHashes.map((u) => JSON.stringify(u)).join("\n"));
    const output = join(dir, "import.ndjson");
    assert.deepEqual(await transformExport(input, output), { count: 3, hashesDropped: 2 });
    assert.equal(mode(output), 0o600);
    assert.equal(fs.readFileSync(output, "utf8").includes("$2b$"), false);
  });

  test("reads a JSON array as well as NDJSON", () => {
    assert.deepEqual(parseAuth0Export(JSON.stringify([ADA, ALAN])), [ADA, ALAN]);
    assert.deepEqual(parseAuth0Export(`${JSON.stringify(ADA)}\n\n${JSON.stringify(ALAN)}\n`), [ADA, ALAN]);
  });

  test("reports a malformed line by its number without quoting it", async () => {
    const input = join(dir, "export.ndjson");
    fs.writeFileSync(input, `${JSON.stringify(ADA)}\n{"email": "leak@example.test",\n`);
    const stderr = [];
    const original = console.error;
    console.error = (message) => stderr.push(String(message));
    try {
      assert.equal(await transformMain([input, join(dir, "out.ndjson")]), 1);
    } finally {
      console.error = original;
    }
    assert.deepEqual(stderr, ["Line 2 is not valid JSON"]);
    assert.equal(fs.existsSync(join(dir, "out.ndjson")), false);
  });
});

describe("describing an export", () => {
  test("names every field path, its types and how many records carry it, and no value", () => {
    const shape = describeRecords([ADA, ALAN]);
    assert.equal(shape.records, 2);
    assert.deepEqual(shape.fields["identities[].isSocial"], { types: "boolean", count: 2 });
    assert.deepEqual(shape.fields.given_name, { types: "string", count: 1 });
    assert.deepEqual(shape.fields["app_metadata.roles[]"], { types: "string", count: 1 });
    const text = JSON.stringify(shape);
    for (const value of ["ada@example.test", "Lovelace", "a1b2c3", "1035", "admin"]) assert.equal(text.includes(value), false, value);
  });
});
