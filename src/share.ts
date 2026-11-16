import { watch } from 'node:fs';
import { join } from 'node:path';
import { SELF, WT_HOME } from './env.ts';
import { baseSession, baseSync, defaultRef, ensureBase } from './base.ts';
import { appWindow, basePorts, profileFor, servicesOf, shareable, worktreePorts } from './profile.ts';
import { proxy } from './proxy.ts';
import { fwdEnv, startRun, words } from './runs.ts';
import { del, get, put } from './state.ts';
import { newWindow, sessAlive, tmux, winState } from './tmux.ts';
import { affected } from './turbo.ts';
import { capture, say, shq, sleep, tee } from './util.ts';
import { resolve, type Wt } from './worktree.ts';

// paths whose changes never reach git
const NOISE = /(^|\/)(node_modules|\.git|\.turbo|dist|\.expo|\.next)(\/|$)/;

async function healthy(port: number, path: string) {
  try {
    return (await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export function startShare(w: Wt) {
  const t = `=${w.name}:share`;
  const st = winState(w.name, 'share');
  const cmd = `WT_LOGIN=1${fwdEnv()} bash -lc ${shq(`${SELF} _share ${w.name}`)}`;
  if (st === 'none') {
    newWindow(w, 'share', cmd);
    tmux('set-option', '-w', '-t', t, 'remain-on-exit', 'on');
  } else if (st !== 'alive') tmux('respawn-pane', '-k', '-t', t, cmd);
  say(`share: proxy for the shared services (wt logs ${w.name} share)`);
}

// fronts the worktree's shareable services on their slot ports. the base checkout serves each
// one until the worktree changes it or a package it depends on; from then on an own instance
// runs, and serves for good once it answers its health check
export async function cmdShare(name: string): Promise<never> {
  const w = resolve(name);
  const rp = profileFor(w.repo, w.path);
  tee(join(WT_HOME, w.name, 'share.log'));
  put(w.name, 'share.pid', process.pid);
  const ports = worktreePorts(rp, Number(get(w.name, 'slot')));
  const base = basePorts(rp);
  const runs = ['dev', ...shareable(rp, Object.keys(rp.services)), ...Object.keys(rp.services).filter((s) => rp.services[s]?.command).map(appWindow)];
  const ref = defaultRef(w.repo);
  const listening = new Set<string>();
  const ready = new Set<string>();
  let dirty = true;
  let lastEvent = 0;
  let mb = '';
  let baseFor = '';
  let shares = '';
  watch(w.path, { recursive: true }, (_e, f) => {
    if (!f || NOISE.test(String(f))) return;
    dirty = true;
    lastEvent = Date.now();
  });
  const stop = () => {
    del(w.name, 'shares', 'share.pid');
    baseSync(rp);
    process.exit(0);
  };
  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(sig, stop);

  for (;;) {
    const svcs = shareable(rp, servicesOf(rp, get(w.name, 'profiles')));
    for (const s of svcs) {
      if (listening.has(s)) continue;
      try {
        await proxy(ports.addr(s), () => (ready.has(s) ? ports.listen(s) : base.listen(s)));
        listening.add(s);
        say(`${s}: proxy on :${ports.addr(s)}`);
      } catch {}
    }

    const own = words(get(w.name, 'own'));
    // a burst of saves settles before turbo looks
    if (dirty && Date.now() - lastEvent > 2000) {
      dirty = false;
      mb = capture('git', ['merge-base', 'HEAD', ref], { cwd: w.path }).stdout.trim();
      const pending = svcs.filter((s) => !own.includes(s));
      if (pending.length) {
        const changed = mb ? await affected(w.path, mb) : undefined;
        const why = changed ? `changed since ${mb.slice(0, 9)}` : mb ? 'turbo could not tell what changed' : `no merge-base with ${ref}`;
        for (const s of pending) {
          if (changed && !changed.includes(rp.services[s]!.pkg!)) continue;
          own.push(s);
          say(`${s}: ${why}, starting an own instance`);
        }
        put(w.name, 'own', own.join(' '));
      }
    }

    for (const s of svcs.filter((s) => own.includes(s))) {
      if (winState(w.name, s) === 'none') await startRun(w, w.name, rp, s, [s], ports, runs);
      if (!ready.has(s) && (await healthy(ports.listen(s), rp.services[s]!.share!))) {
        ready.add(s);
        say(`${s}: own instance answers on :${ports.listen(s)}, serving from it`);
      }
    }

    const shared = svcs.filter((s) => !own.includes(s));
    if (shared.length && mb && (baseFor !== mb || !sessAlive(baseSession(rp)))) {
      baseFor = mb;
      if (!(await ensureBase(rp, mb))) {
        say(`base: cannot serve ${shared.join(', ')}, starting own instances`);
        put(w.name, 'own', [...own, ...shared].join(' '));
      }
    }

    const now = svcs.filter((s) => !ready.has(s)).join(' ');
    if (now !== shares) {
      shares = now;
      if (now) put(w.name, 'shares', now);
      else {
        del(w.name, 'shares');
        baseSync(rp);
      }
    }
    await sleep(1000);
  }
}
