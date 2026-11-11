/**
 * Turns the Auth0 user records scripts/export-auth0-users.mjs wrote into
 * Udibo's user import records (`UserImportRecord`), one per line, following
 * the field mapping in Udibo's Auth0 migration recipe:
 *
 *   email, email_verified          → email, emailVerified
 *   nickname, given_name,
 *   family_name, name              → username, firstName, lastName, displayName
 *   identities[] where isSocial    → identities[] ({ provider, subject: user_id }),
 *                                    for providers Udibo has a preset for
 *   app_metadata, user_metadata    → metadata, userMetadata
 *
 * No record carries a `legacyCredential`: Auth0 releases password hashes only
 * through a support request its Free plan cannot make, so every account
 * imports without a password. A record that does carry `password_hash` or
 * `custom_password_hash` has it dropped, and the count is reported.
 *
 * Udibo stores a social identity under its preset type (`google`, `github`,
 * `apple`), where Auth0 names the provider `google-oauth2`, `github` or
 * `apple`, so the provider is translated. An identity from any other Auth0
 * social connection has no Udibo preset to match and is left out, counted.
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

/** Auth0 social provider name → Udibo preset type, for the presets whose subject is the provider's own user id. */
export const AUTH0_SOCIAL_PRESETS = { "google-oauth2": "google", github: "github", apple: "apple" };

function socialIdentities(user) {
  return (user.identities ?? []).filter((identity) => identity.isSocial === true);
}

/** How many of a record's social identities have no Udibo preset and are left out. */
export function unmappedSocialIdentities(user) {
  return socialIdentities(user).filter((identity) => !Object.hasOwn(AUTH0_SOCIAL_PRESETS, identity.provider)).length;
}

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
  const identities = socialIdentities(user)
    .filter((identity) => Object.hasOwn(AUTH0_SOCIAL_PRESETS, identity.provider))
    .map((identity) => ({ provider: AUTH0_SOCIAL_PRESETS[identity.provider], subject: String(identity.user_id) }));
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

/** Parses `text` as JSON, reporting a failure by `where` alone: JSON.parse's message quotes the input. */
export function parseJson(text, where) {
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
 * Resolves with `{ count, hashesDropped, identitiesDropped }`.
 */
export async function transformExport(input, output, signal) {
  const users = parseAuth0Export(fs.readFileSync(input, "utf8"));
  const hashesDropped = users.filter(carriesPasswordHash).length;
  const identitiesDropped = users.reduce((sum, user) => sum + unmappedSocialIdentities(user), 0);
  const count = await writePrivateNdjson(users.map(toImportRecord), output, signal);
  return { count, hashesDropped, identitiesDropped };
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
      const { count, hashesDropped, identitiesDropped } = await transformExport(input, output, signal);
      console.error(`Wrote ${count} import records to ${output} (mode 0600), none with a password.`);
      if (hashesDropped > 0) console.error(`${hashesDropped} records carried a password hash, which was left out.`);
      if (identitiesDropped > 0) {
        console.error(`${identitiesDropped} social identities came from a provider Udibo has no preset for, and were left out.`);
      }
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
