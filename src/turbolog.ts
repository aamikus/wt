import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { out } from './util.ts';

// turbo --log-file streams a json array into .turbo/logs/<epoch ms>.json, one object per line.
// each run of a checkout writes its own, so a package's output is in the newest log that has any
export function turboLog(dir: string, pkg?: string) {
  const logs = join(dir, '.turbo/logs');
  let files: string[];
  try {
    files = readdirSync(logs).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 10);
  } catch {
    return;
  }
  return files.map((f) => join(logs, f)).find((f) => !pkg || readFileSync(f, 'utf8').includes(`{"source":"${pkg}#dev"`));
}

// one line of a turbo log as text: a package's dev task alone, or every task prefixed with
// its name; anything else is undefined
export function taskLine(line: string, pkg?: string) {
  if (!line.startsWith(pkg ? `{"source":"${pkg}#dev"` : '{"source"')) return;
  try {
    const o = JSON.parse(line.replace(/},$/, '}')) as { source: string; text: string };
    return pkg ? o.text : `${o.source}: ${o.text}`;
  } catch {
    return;
  }
}

export function taskText(file: string, pkg?: string) {
  const outLines: string[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const t = taskLine(l, pkg);
    if (t !== undefined) outLines.push(t);
  }
  return outLines;
}

// follows a turbo log like tail -F, printing one task's lines until interrupted
export function followTask(file: string, pkg?: string): Promise<number> {
  return new Promise((resolve) => {
    const t = spawn('tail', ['-n', '400', '-F', file], { stdio: ['ignore', 'pipe', 'inherit'] });
    let rest = '';
    t.stdout.on('data', (d: Buffer) => {
      const parts = (rest + d.toString()).split('\n');
      rest = parts.pop() ?? '';
      for (const l of parts) {
        const x = taskLine(l, pkg);
        if (x !== undefined) out(`${x}\n`);
      }
    });
    t.on('close', (code) => resolve(code ?? 0));
  });
}
