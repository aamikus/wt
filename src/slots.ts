import { join } from 'node:path';
import { WT_HOME } from './env.ts';
import { slotPorts } from './profile.ts';
import { get, lock, names, put, unlock } from './state.ts';
import { capture, die } from './util.ts';

// every TCP port something listens on; lsof takes ~0.3 s a call, so callers that ask
// repeatedly load this once
export function listenPorts() {
  const r = capture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']);
  const ports = new Set<number>();
  for (const l of r.stdout.split('\n')) {
    const m = /^n.*:(\d+)$/.exec(l);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

export type Listening = (port: number) => boolean;

export const listening: Listening = (port) =>
  capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).code === 0;

// the worktree's slot, allocating the lowest one no other worktree holds and nothing
// listens on. slot 0 is the main checkout's default ports
export async function slotFor(n: string, isListening?: Listening) {
  const have = get(n, 'slot');
  if (have) return Number(have);
  const l = join(WT_HOME, '.slots');
  await lock(l);
  try {
    const open = isListening ? undefined : listenPorts();
    const occupied = isListening ?? ((port: number) => open!.has(port));
    const taken = new Set(names().map((m) => get(m, 'slot')).filter(Boolean).map(Number));
    for (let k = 1; k <= 20; k++) {
      if (taken.has(k) || slotPorts(k).some(occupied)) continue;
      put(n, 'slot', k);
      return k;
    }
  } finally {
    unlock(l);
  }
  die('no free slot: wt ls shows the environments holding one, wt clean --yes frees those of removed worktrees');
}
