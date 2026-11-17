import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Props for a preview: `.preview/<name>-props.json` at the repo root (written by
 * `pnpm collect … --html`; gitignored, may hold real data), else the committed made-up sample.
 */
export function loadPreviewProps<T>(name: string, fallback: T): T {
  // The dev server runs in packages/emails; INIT_CWD is where `pnpm email:preview` was started.
  const roots = [process.env.INIT_CWD, process.cwd(), resolve(process.cwd(), '../..')];
  for (const root of roots) {
    if (!root) continue;
    const file = resolve(root, '.preview', `${name}-props.json`);
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        // fall through to the sample
      }
    }
  }
  return fallback;
}
