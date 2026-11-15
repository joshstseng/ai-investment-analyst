/** Minimal structured logger: one line per event, UTC timestamp, JSON fields. */
type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
    fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''
  }`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
