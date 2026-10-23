import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const DTD_PATH = fileURLToPath(new URL('./fixtures/tmx14.dtd', import.meta.url));

export function tempDir(prefix = 'tmx-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Resolves true when xmllint is installed (validation tests are skipped otherwise). */
export async function hasXmllint() {
  try {
    await run('xmllint', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Validates a TMX file against the TMX 1.4b DTD with xmllint; rejects with xmllint's output. */
export async function validateWithDtd(file) {
  await run('xmllint', ['--noout', '--nonet', '--dtdvalid', DTD_PATH, file]);
}
