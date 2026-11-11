/**
 * Turns the Auth0 user records scripts/export-auth0-users.mjs wrote into
 * Udibo's user import records (`UserImportRecord`), one per line, following
 * the field mapping in Udibo's Auth0 migration recipe:
 *
 *   email, email_verified          → email, emailVerified
 *   nickname, given_name,
 *   family_name, name              → username, firstName, lastName, displayName
 *   identities[] where isSocial    → identities[] ({ provider, subject: user_id })
 *   app_metadata, user_metadata    → metadata, userMetadata
 *
 * No record carries a `legacyCredential`: Auth0 releases password hashes only
 * through a support request its Free plan cannot make, so every account
 * imports without a password. A record that does carry `password_hash` or
 * `custom_password_hash` has it dropped, and the count is reported.
 *
 *   npm run auth0-to-udibo -- <auth0 export> <udibo import file>
 *
 * The output holds the same personal data as the input and is written the same
 * way: <file>.partial with mode 0600, renamed when complete, removed when the
 * command fails or is interrupted. Nothing is written to stdout.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { withInterrupts, writePrivateNdjson } from "./private-file.mjs";

const USAGE = "Usage: npm run auth0-to-udibo -- <auth0 export> <udibo import file>";

function present(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 ? value : undefined;
}

/** True when an Auth0 record carries a password hash, which the transform drops. */
export function carriesPasswordHash(user) {
  return user.password_hash !== undefined || user.custom_password_hash !== undefined;
}

/** Maps one Auth0 user record to a Udibo `UserImportRecord`, leaving out absent fields. */
export function toImportRecord(user) {
  const identities = (user.identities ?? [])
    .filter((identity) => identity.isSocial === true)
    .map((identity) => ({ provider: identity.provider, subject: String(identity.user_id) }));
  const record = {
    email: present(user.email),
    emailVerified: user.email_verified === true,
    username: present(user.nickname),
    firstName: present(user.given_name),
    lastName: present(user.family_name),
    displayName: present(user.name),
    identities: identities.length > 0 ? identities : undefined,
    metadata: object(user.app_metadata),
    userMetadata: object(user.user_metadata),
  };
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError(`${where} is not valid JSON`);
  }
}

/**
 * Parses an Auth0 export: a JSON array, or NDJSON. A malformed line is
 * reported by its number only, since JSON.parse's message quotes the input.
 */
export function parseAuth0Export(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) return parseJson(trimmed, "The export");
  return trimmed
    .split("\n")
    .map((line, index) => [line, index + 1])
    .filter(([line]) => line.trim() !== "")
    .map(([line, number]) => parseJson(line, `Line ${number}`));
}

/**
 * Transforms the export at `input` into a new import file at `output`.
 * Resolves with `{ count, hashesDropped }`.
 */
export async function transformExport(input, output, signal) {
  const users = parseAuth0Export(fs.readFileSync(input, "utf8"));
  const hashesDropped = users.filter(carriesPasswordHash).length;
  const count = await writePrivateNdjson(users.map(toImportRecord), output, signal);
  return { count, hashesDropped };
}

/** Runs the command with `args`; resolves with the exit code and reports counts to stderr. */
export async function main(args) {
  if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) {
    console.error(USAGE);
    return 2;
  }
  const [input, output] = args;
  try {
    return await withInterrupts(async (signal) => {
      const { count, hashesDropped } = await transformExport(input, output, signal);
      console.error(`Wrote ${count} import records to ${output} (mode 0600), none with a password.`);
      if (hashesDropped > 0) console.error(`${hashesDropped} records carried a password hash, which was left out.`);
      return 0;
    }, () => console.error("Interrupted; no file was written."));
  } catch (error) {
    console.error(error.code === "EEXIST" ? `${output} (or ${output}.partial) already exists; choose a new path.` : error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
