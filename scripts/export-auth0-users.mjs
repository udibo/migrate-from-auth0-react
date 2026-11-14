/**
 * Exports the Auth0 tenant's users to an NDJSON file, one Auth0 user record
 * per line, for scripts/auth0-to-udibo.mjs to turn into Udibo import records.
 * The file holds every user's email address and profile: treat it as personal
 * data, keep it out of version control, and delete it once the import is
 * verified. It holds no password hashes: the Management API does not return
 * them.
 *
 *   npm run export:auth0 -- <file> [--connection-id=con_…]
 *
 * It signs in as a machine-to-machine application authorized for the Auth0
 * Management API with `read:users` (AUTH0_DOMAIN, AUTH0_EXPORT_CLIENT_ID and
 * AUTH0_EXPORT_CLIENT_SECRET from the environment), then asks for a bulk
 * export job (POST /api/v2/jobs/users-exports), polls it and downloads its
 * gzipped NDJSON. When Auth0 refuses the job or its status, it says why and
 * reads the users page by page from GET /api/v2/users instead, asking for the
 * same fields. Auth0 pages through only the first 1,000 users and refuses
 * the page after, so the fallback suits a small tenant; a larger one fails
 * rather than writing part of its users.
 *
 * The records go to <file>.partial, created with mode 0600, which becomes
 * <file> only once every user is written; the command refuses a path that
 * already exists, and removes the partial file when it fails or is
 * interrupted (SIGHUP, SIGINT, SIGTERM). It never writes a record to stdout or
 * stderr.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { parseJson } from "./auth0-to-udibo.mjs";
import { refuseExisting, withInterrupts, writePrivateNdjson } from "./private-file.mjs";

const USAGE = "Usage: npm run export:auth0 -- <file> [--connection-id=con_…]";
const PAGE_SIZE = 100;

/** The profile fields the export job is asked for: everything scripts/auth0-to-udibo.mjs maps, and the account's state. */
export const EXPORT_FIELDS = [
  "user_id",
  "email",
  "email_verified",
  "username",
  "nickname",
  "name",
  "given_name",
  "family_name",
  "picture",
  "identities",
  "app_metadata",
  "user_metadata",
  "blocked",
  "created_at",
  "updated_at",
  "last_login",
  "logins_count",
];

/** An Auth0 answer the export could not use, with what Auth0 said and nothing from the request. */
export class Auth0Refusal extends Error {
  constructor(step, status, body) {
    const detail = [body?.errorCode ?? body?.error, body?.message ?? body?.error_description].filter(Boolean).join(": ");
    super(`${step}: Auth0 answered ${status}${detail ? ` (${detail})` : ""}`);
    this.step = step;
    this.status = status;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function call(fetchImpl, step, url, init, signal) {
  const response = await fetchImpl(url, { ...init, signal });
  if (!response.ok) throw new Auth0Refusal(step, response.status, await readJson(response));
  return response;
}

async function managementToken({ domain, clientId, clientSecret, fetch: fetchImpl, signal }) {
  const response = await call(
    fetchImpl,
    "token",
    `https://${domain}/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        audience: `https://${domain}/api/v2/`,
      }),
    },
    signal,
  );
  return (await response.json()).access_token;
}

async function* exportJobUsers({ domain, connectionId, token, fetch: fetchImpl, signal, pollIntervalMs, timeoutMs }) {
  const api = `https://${domain}/api/v2`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await call(
    fetchImpl,
    "export job",
    `${api}/jobs/users-exports`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        format: "json",
        fields: EXPORT_FIELDS.map((name) => ({ name })),
        ...(connectionId ? { connection_id: connectionId } : {}),
      }),
    },
    signal,
  );
  let job = await created.json();
  const deadline = Date.now() + timeoutMs;
  while (job.status !== "completed") {
    if (job.status === "failed") throw new Auth0Refusal("export job", 200, { message: "the job failed" });
    if (Date.now() > deadline) throw new Auth0Refusal("export job", 200, { message: "the job did not finish in time" });
    await sleep(pollIntervalMs, undefined, { signal });
    job = await (await call(fetchImpl, "export job status", `${api}/jobs/${encodeURIComponent(job.id)}`, { headers }, signal)).json();
  }
  const download = await call(fetchImpl, "export download", job.location, {}, signal);
  const text = gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8");
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() !== "") yield parseJson(line, `Line ${index + 1} of the export job's file`);
  }
}

async function* usersApiUsers({ domain, token, fetch: fetchImpl, signal }) {
  for (let page = 0; ; page += 1) {
    const url = new URL(`https://${domain}/api/v2/users`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("fields", EXPORT_FIELDS.join(","));
    url.searchParams.set("include_fields", "true");
    const response = await call(fetchImpl, "users API", url, { headers: { authorization: `Bearer ${token}` } }, signal);
    const users = await response.json();
    if (users.length === 0) return;
    yield* users;
  }
}

/**
 * Exports the tenant's users to a new file at `file`. Resolves with
 * `{ count, source, jobRefusal }`: the users written, `"export job"` or
 * `"users API"`, and why the export job could not be used when it was not.
 * Rejects, leaving neither file, when the export fails or `options.signal`
 * aborts.
 */
export async function exportAuth0Users(file, options) {
  const {
    domain,
    clientId,
    clientSecret,
    connectionId,
    signal,
    fetch: fetchImpl = globalThis.fetch,
    pollIntervalMs = 2000,
    timeoutMs = 120_000,
  } = options;
  for (const [name, value] of Object.entries({ domain, clientId, clientSecret })) {
    if (!value) throw new TypeError(`Missing ${name}`);
  }
  refuseExisting(file);
  const context = { domain, connectionId, fetch: fetchImpl, signal, pollIntervalMs, timeoutMs };
  context.token = await managementToken({ ...context, clientId, clientSecret });

  let jobRefusal;
  let records;
  try {
    records = [];
    for await (const record of exportJobUsers(context)) records.push(record);
  } catch (error) {
    if (!(error instanceof Auth0Refusal) || signal?.aborted) throw error;
    jobRefusal = error.message;
    records = undefined;
  }
  if (records) return { count: await writePrivateNdjson(records, file, signal), source: "export job", jobRefusal };
  return { count: await writePrivateNdjson(usersApiUsers(context), file, signal), source: "users API", jobRefusal };
}

function parseArguments(args) {
  let file;
  let connectionId;
  for (const arg of args) {
    const match = /^--connection-id=(.+)$/.exec(arg);
    if (match) connectionId = match[1];
    else if (arg.startsWith("-") || file !== undefined) throw new TypeError(USAGE);
    else file = arg;
  }
  if (!file) throw new TypeError(USAGE);
  return { file, connectionId };
}

/**
 * Runs the command with `args` (the arguments after the script name) and the
 * environment's AUTH0_* settings. Resolves with the exit code; reports counts
 * and refusals to stderr, never a record.
 */
export async function main(args, env = process.env) {
  let parsed;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  try {
    return await withInterrupts(async (signal) => {
      const { count, source, jobRefusal } = await exportAuth0Users(parsed.file, {
        domain: env.AUTH0_DOMAIN,
        clientId: env.AUTH0_EXPORT_CLIENT_ID,
        clientSecret: env.AUTH0_EXPORT_CLIENT_SECRET,
        connectionId: parsed.connectionId,
        signal,
      });
      if (jobRefusal) console.error(`The export job was not usable, so the users were read from GET /api/v2/users. ${jobRefusal}`);
      console.error(`Exported ${count} users from the ${source} to ${parsed.file} (mode 0600).`);
      console.error("The file holds every user's email address and profile. Delete it once the import is verified.");
      return 0;
    }, () => console.error("Interrupted; no file was written."));
  } catch (error) {
    console.error(error.code === "EEXIST" ? `${parsed.file} (or ${parsed.file}.partial) already exists; choose a new path.` : error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
