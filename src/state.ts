import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WT_HOME } from './env.ts';
import { alive, die, now, sleep } from './util.ts';

// a worktree's state is one file per key under WT_HOME/<name>, shared with the bash wt

export const stateDir = (n: string) => join(WT_HOME, n);

export function get(n: string, k: string) {
  try {
    return readFileSync(join(WT_HOME, n, k), 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

export function put(n: string, k: string, v: string | number) {
  mkdirSync(join(WT_HOME, n), { recursive: true });
  writeFileSync(join(WT_HOME, n, k), `${v}\n`);
}

export function del(n: string, ...ks: string[]) {
  for (const k of ks) rmSync(join(WT_HOME, n, k), { force: true });
}

// a person or an agent used the worktree's environment now
export const touch = (n: string) => put(n, 'active', now());

export const has = (n: string, k: string) => existsSync(join(WT_HOME, n, k));

// every worktree wt keeps state for
export function names() {
  return readdirSync(WT_HOME, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

export async function lock(path: string, timeoutS = 900) {
  const l = `${path}.lock`;
  mkdirSync(dirname(l), { recursive: true });
  for (let i = 0; i < timeoutS; i++) {
    try {
      mkdirSync(l);
      writeFileSync(join(l, 'pid'), `${process.pid}\n`);
      return;
    } catch {}
    // a holder that died leaves its lock behind; an empty pid is a holder still starting
    let pid = '';
    try {
      pid = readFileSync(join(l, 'pid'), 'utf8').trim();
    } catch {}
    if (pid && !alive(Number(pid))) rmSync(l, { recursive: true, force: true });
    await sleep(1000);
  }
  die(`timed out waiting for ${l}`);
}

export const unlock = (path: string) => rmSync(`${path}.lock`, { recursive: true, force: true });

// up.pid holds the orchestrator's pid, or starting:<epoch> until its login shell is up
export function runningUp(n: string) {
  const v = get(n, 'up.pid');
  if (!v) return false;
  if (v.startsWith('starting:')) return now() - Number(v.slice(9)) < 60;
  return alive(Number(v));
}
