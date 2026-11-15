import { createDb } from '@aia/db';
import { AlpacaClient } from './alpaca/client';
import { loadEnv } from './env';
import { log } from './lib/log';
import { createMailer } from './notify/mailer';
import { SecClient } from './sec/client';

export function createContext() {
  const env = loadEnv();
  const { db, sql } = createDb(env.DATABASE_URL);
  const alpaca = new AlpacaClient(env);
  const sec = env.SEC_USER_AGENT ? new SecClient(env.SEC_USER_AGENT) : null;
  const mailer = createMailer(env, {
    onRetry: (info) => log.warn('email send retry', info),
  });
  return {
    env,
    db,
    alpaca,
    sec,
    mailer,
    requireSec(): SecClient {
      if (!sec) throw new Error('SEC_USER_AGENT is not set; EDGAR collection is disabled');
      return sec;
    },
    close: () => sql.end(),
  };
}

export type Context = ReturnType<typeof createContext>;
