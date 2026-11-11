/**
 * Writes records holding personal data to an NDJSON file no other local user
 * can read: <file>.partial, created with mode 0600, becomes <file> only once
 * every record is written, and is removed when the write fails or `signal`
 * aborts. Refuses a <file> or <file>.partial that already exists, including a
 * link planted there.
 */

import fs from "node:fs";

const FILE_MODE = 0o600;

/** The signals that stop a write, and the exit code each one ends the command with. */
export const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Throws an `EEXIST` error when `file` already exists. */
export function refuseExisting(file) {
  if (fs.existsSync(file)) {
    const error = new Error(`${file} already exists`);
    error.code = "EEXIST";
    throw error;
  }
}

/** Writes `records` (any iterable or async iterable) to a new `file`; resolves with how many it wrote. */
export async function writePrivateNdjson(records, file, signal) {
  const partial = `${file}.partial`;
  refuseExisting(file);
  let fd = fs.openSync(partial, "wx", FILE_MODE);
  let count = 0;
  try {
    fs.fchmodSync(fd, FILE_MODE);
    for await (const record of records) {
      signal?.throwIfAborted();
      fs.writeSync(fd, JSON.stringify(record) + "\n");
      count += 1;
    }
    signal?.throwIfAborted();
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(partial, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(partial, { force: true });
  }
  return count;
}

/**
 * Runs `work(signal)` with SIGHUP, SIGINT and SIGTERM aborting `signal`, and
 * resolves with the exit code: `work`'s, or the signal's when one arrived.
 */
export async function withInterrupts(work, onInterrupted) {
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(signal);
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.on(signal, interrupt);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      onInterrupted();
      return SIGNAL_EXIT_CODES[controller.signal.reason];
    }
    throw error;
  } finally {
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.off(signal, interrupt);
  }
}
