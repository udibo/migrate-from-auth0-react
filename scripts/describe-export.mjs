/**
 * Prints the shape of an Auth0 user export: how many records, and for every
 * field path the type it holds and in how many records it appears. It never
 * prints a value, so its output can go in a CI log.
 *
 *   node scripts/describe-export.mjs <auth0 export>
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseAuth0Export } from "./auth0-to-udibo.mjs";

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(value, path, shape) {
  const type = typeOf(value);
  const entry = (shape[path] ??= { types: new Set(), count: 0 });
  entry.types.add(type);
  entry.count += 1;
  if (type === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, shape);
  } else if (type === "array") {
    for (const child of value) walk(child, `${path}[]`, shape);
  }
}

/** The shape of `records`: `{ records, fields: { [path]: { types, count } } }`, with no values. */
export function describeRecords(records) {
  const shape = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) walk(value, key, shape);
  }
  const fields = Object.fromEntries(
    Object.entries(shape)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, { types, count }]) => [path, { types: [...types].sort().join("|"), count }]),
  );
  return { records: records.length, fields };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file] = process.argv.slice(2);
  console.log(JSON.stringify(describeRecords(parseAuth0Export(fs.readFileSync(file, "utf8"))), null, 2));
}
