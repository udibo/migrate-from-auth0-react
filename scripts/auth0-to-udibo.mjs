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
 * With `--remote-password=<connection>`, each database user of that Auth0
 * connection also gets `remotePassword: { subject, login }`: its Auth0
 * `user_id`, and the email (or, without one, the username) it signs in to
 * Auth0 with. Udibo then checks that user's first password sign-in against
 * Auth0 and keeps the password once Auth0 confirms it. `remotePasswordFor`
 * lists who is written without it.
 *
 *   npm run auth0-to-udibo -- --remote-password=<connection> <auth0 export> <udibo import file>
 *
 * The output holds the same personal data as the input and is written the same
 * way: <file>.partial with mode 0600, renamed when complete, removed when the
 * command fails or is interrupted. Nothing is written to stdout.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { withInterrupts, writePrivateNdjson } from "./private-file.mjs";

const REMOTE_PASSWORD_FLAG = "--remote-password=";
const USAGE = `Usage: npm run auth0-to-udibo -- [${REMOTE_PASSWORD_FLAG}<connection>] <auth0 export> <udibo import file>`;

/** The longest `subject` or `login` Udibo's import accepts in a `remotePassword`. */
export const REMOTE_PASSWORD_PART_MAX_LENGTH = 255;

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

/**
 * The `remotePassword` for a user who signs in to Auth0 with a password in
 * the database connection named `connection`, or undefined for anyone else.
 * `subject` is the `sub` Auth0 puts in that user's ID token, which is what
 * Udibo compares; `login` is what Auth0's password grant takes as `username`:
 * the email when the user has one, else the Auth0 username.
 *
 * Undefined for a blocked user, a user with no login, a user whose `subject`
 * or `login` is longer than Udibo accepts, a user whose database identity is
 * not the one `user_id` names, and a user with no email whose Auth0 username
 * is not the username the import record carries (Auth0's `nickname`), since
 * that person could not name their Udibo account with it.
 */
export function remotePasswordFor(user, connection) {
  if (user.blocked === true) return undefined;
  const email = present(user.email);
  const login = email ?? present(user.username);
  if (login === undefined || login.length > REMOTE_PASSWORD_PART_MAX_LENGTH) return undefined;
  if (email === undefined && login !== present(user.nickname)) return undefined;
  const subject = user.user_id;
  const signsInHere = (user.identities ?? []).some((identity) => identity.connection === connection && subject === `auth0|${identity.user_id}`);
  return signsInHere && subject.length <= REMOTE_PASSWORD_PART_MAX_LENGTH ? { subject, login } : undefined;
}

/**
 * Maps one Auth0 user record to a Udibo `UserImportRecord`, leaving out absent
 * fields. With `remotePasswordConnection`, a password user of that connection
 * also gets a `remotePassword` (see `remotePasswordFor`).
 */
export function toImportRecord(user, { remotePasswordConnection } = {}) {
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
    remotePassword: remotePasswordConnection ? remotePasswordFor(user, remotePasswordConnection) : undefined,
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
 * Resolves with `{ count, hashesDropped, identitiesDropped }`, and with
 * `remotePasswords`, how many records carry one, when
 * `remotePasswordConnection` is given.
 */
export async function transformExport(input, output, signal, { remotePasswordConnection } = {}) {
  const users = parseAuth0Export(fs.readFileSync(input, "utf8"));
  const hashesDropped = users.filter(carriesPasswordHash).length;
  const identitiesDropped = users.reduce((sum, user) => sum + unmappedSocialIdentities(user), 0);
  const records = users.map((user) => toImportRecord(user, { remotePasswordConnection }));
  const count = await writePrivateNdjson(records, output, signal);
  if (!remotePasswordConnection) return { count, hashesDropped, identitiesDropped };
  return { count, hashesDropped, identitiesDropped, remotePasswords: records.filter((record) => record.remotePassword).length };
}

/** Runs the command with `args`; resolves with the exit code and reports counts to stderr. */
export async function main(args) {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const paths = args.filter((arg) => !arg.startsWith("-"));
  const remotePasswordConnection = flags[0]?.startsWith(REMOTE_PASSWORD_FLAG) ? flags[0].slice(REMOTE_PASSWORD_FLAG.length) : undefined;
  if (paths.length !== 2 || flags.length > 1 || (flags.length === 1 && !remotePasswordConnection)) {
    console.error(USAGE);
    return 2;
  }
  const [input, output] = paths;
  try {
    return await withInterrupts(async (signal) => {
      const { count, hashesDropped, identitiesDropped, remotePasswords } = await transformExport(input, output, signal, { remotePasswordConnection });
      const passwords =
        remotePasswords === undefined
          ? "none with a password"
          : `${remotePasswords} with a remotePassword for the ${remotePasswordConnection} connection and ${count - remotePasswords} with no password`;
      console.error(`Wrote ${count} import records to ${output} (mode 0600), ${passwords}.`);
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
