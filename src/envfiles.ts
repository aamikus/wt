import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARK = '# managed by wt';

// written whole by writeEnv, with one checkout's ports
export const managed = (f: string) => readFileSync(f, 'utf8').startsWith(MARK);

// sets KEY=value lines in an env file: a missing or wt-written file is written whole, any other
// file, such as one pulled from a secrets manager, has just these keys replaced or appended
export function writeEnv(dir: string, rel: string, vars: Record<string, string>) {
  const f = join(dir, rel);
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  if (!existsSync(f) || managed(f)) {
    writeFileSync(f, `${[MARK, ...lines].join('\n')}\n`);
    return;
  }
  let text = readFileSync(f, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'gm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n?$/, '\n')}${k}=${v}\n`;
  }
  writeFileSync(f, text);
}
