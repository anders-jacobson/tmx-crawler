/**
 * Minimal, dependency-free structured logger.
 * Progress and diagnostics go to stderr so stdout stays clean for the final summary.
 */

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * @param {object} [options]
 * @param {keyof LOG_LEVELS} [options.level='info']
 * @param {boolean} [options.json=false]  Emit one JSON object per line (useful for log shipping).
 * @param {{ write(chunk: string): unknown }} [options.stream=process.stderr]
 */
export function createLogger({ level = 'info', json = false, stream = process.stderr } = {}) {
  if (!(level in LOG_LEVELS)) {
    throw new Error(`Unknown log level "${level}". Use one of: ${Object.keys(LOG_LEVELS).join(', ')}`);
  }
  const threshold = LOG_LEVELS[level];

  const emit = (lvl, message, meta) => {
    if (LOG_LEVELS[lvl] < threshold) return;
    const time = new Date().toISOString();
    if (json) {
      stream.write(`${JSON.stringify({ time, level: lvl, message, ...meta })}\n`);
      return;
    }
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    stream.write(`${time} ${lvl.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
  };

  return {
    level,
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

/** A logger that discards everything (handy in tests). */
export const silentLogger = createLogger({ level: 'silent' });
