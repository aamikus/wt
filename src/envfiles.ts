import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { say } from './util.ts';

const MARK = '# managed by wt';

// a gitignored override the dev servers apply last; a file wt did not write is left alone
export function pin(dir: string, rel: string, line: string) {
  const f = join(dir, rel);
  if (existsSync(f) && !readFileSync(f, 'utf8').split('\n').some((l) => l.startsWith(MARK))) {
    say(`dev: ${rel} is not wt's, leaving it`);
    return;
  }
  writeFileSync(f, `${MARK}\n${line}\n`);
}

// a key the pulled env file defines can only move inside that file; a re-pull resets it and
// the next up writes it again
export function pinPulled(dir: string, rel: string, key: string, value: string) {
  const f = join(dir, rel);
  if (!existsSync(f)) return;
  const text = readFileSync(f, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'gm');
  if (re.test(text)) writeFileSync(f, text.replace(re, `${key}=${value}`));
  else appendFileSync(f, `${key}=${value}\n`);
}
