import { HOME } from './env.ts';
import { runningAvds, simDevices, simState } from './devices.ts';
import { baseSession, baseState } from './base.ts';
import { appWindow, basePorts, profileFor, registry, servicesOf, shareable, worktreePorts } from './profile.ts';
import { words } from './runs.ts';
import { listening, listenPorts, type Listening } from './slots.ts';
import { get, names, runningUp } from './state.ts';
import { sessAlive, winState } from './tmux.ts';
import { out } from './util.ts';
import { canonical, knownRepos, worktreesOf, wtPath } from './worktree.ts';

export interface ServiceState {
  name: string;
  port?: number;
  // which instance serves a shared service
  from?: 'base' | 'own';
  // a server: running, starting, crashed or stopped; a device: what it reports, or off
  state: string;
}

// a worktree's services with their state, and the simulator and emulator. device names the
// state a device is in, defaulting to the worktree's name
export function serviceStates(n: string, isListening: Listening = listening, device: (kind: string) => string = () => n) {
  const rp = profileFor(get(n, 'repo'), get(n, 'path') || get(n, 'repo'));
  const k = get(n, 'slot');
  const own = words(get(n, 'own'));
  const shared = shareable(rp, Object.keys(rp.services));
  const out: ServiceState[] = [];
  for (const s of servicesOf(rp, get(n, 'profiles'))) {
    const svc = rp.services[s];
    if (svc?.device) {
      out.push({ name: s, state: device(svc.device) });
      continue;
    }
    if (!k || !svc) continue;
    const ports = worktreePorts(rp, Number(k));
    const from = !shared.includes(s) ? undefined : own.includes(s) ? 'own' : 'base';
    const win = winState(n, !from ? svc.command ? appWindow(s) : 'dev' : from === 'own' ? s : 'share');
    // the share window starts an own instance's window itself
    const coming = runningUp(n) || (from === 'own' && winState(n, 'share') === 'alive');
    const serving = svc.port ? from === 'base' ? basePorts(rp).listen(s) : ports.listen(s) : undefined;
    let state = 'running';
    if (win === 'dead') state = 'crashed';
    else if (win === 'none') state = coming ? 'starting' : 'stopped';
    else if (serving !== undefined && (!isListening(ports.addr(s)) || !isListening(serving))) state = 'starting';
    out.push({ name: s, port: svc.port ? ports.addr(s) : undefined, from, state });
  }
  return out;
}

const label = (s: ServiceState) =>
  s.port === undefined ? `${s.name} ${s.state}` : `${s.name} :${s.port}${s.from ? ` ${s.from}` : ''}${s.state === 'running' ? '' : ` (${s.state})`}`;

export const services = (n: string, isListening: Listening = listening, device?: (kind: string) => string) =>
  serviceStates(n, isListening, device).map(label);

export const summary = (n: string, isListening: Listening = listening) =>
  services(n, isListening).join(' · ') || 'no services';

function short(repo: string) {
  if (repo.startsWith(`${HOME}/projects/`)) return repo.slice(`${HOME}/projects/`.length);
  if (repo.startsWith(HOME)) return `~${repo.slice(HOME.length)}`;
  return repo;
}

export interface Row {
  repo: string;
  name: string;
  profiles: string;
  setup: string;
  services: string[];
}

function setupLabel(v: string): [string, number] {
  if (v === '0' || v === 'ok') return ['ok', 32];
  if (v === 'running') return [v, 33];
  if (/^\d+$/.test(v)) return [`failed ${v}`, 31];
  if (v.startsWith('failed')) return [v, 31];
  return [v || '-', 2];
}

// rows grouped under their repo; services wrap inside their own column, never under the name
export function table(rows: Row[], width = Infinity, color = false) {
  const paint = (s: string, code: number) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const profW = Math.max(8, ...rows.map((r) => r.profiles.length));
  const setupW = Math.max(5, ...rows.map((r) => setupLabel(r.setup)[0].length));
  const indent = 2 + nameW + 2 + profW + 2 + setupW + 2;
  const svcW = Math.max(30, width - indent);
  const pad = (s: string, w: number) => s.padEnd(w);
  let text = paint(`  ${pad('NAME', nameW)}  ${pad('PROFILES', profW)}  ${pad('SETUP', setupW)}  SERVICES`, 2) + '\n';
  const repos = [...new Set(rows.map((r) => r.repo))].sort();
  for (const repo of repos) {
    text += `\n${paint(repo, 1)}\n`;
    const mine = rows.filter((r) => r.repo === repo).sort((a, b) => (a.name === 'base' ? -1 : b.name === 'base' ? 1 : a.name.localeCompare(b.name)));
    for (const r of mine) {
      const [label, code] = setupLabel(r.setup);
      const svc = r.services.length ? fill(r.services, svcW) : [paint('no services', 2)];
      text += `  ${pad(r.name, nameW)}  ${pad(r.profiles || '-', profW)}  ${paint(pad(label, setupW), code)}  ${svc[0]}\n`;
      for (const l of svc.slice(1)) text += `${' '.repeat(indent)}${l}\n`;
    }
  }
  return text;
}

function fill(parts: string[], width: number) {
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    const next = cur ? `${cur} · ${p}` : p;
    if (cur && next.length > width) {
      lines.push(cur);
      cur = p;
    } else cur = next;
  }
  return [...lines, cur];
}

export interface WorktreeEntry {
  repo: string;
  name: string;
  path: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  locked?: string;
  prunable?: string;
  // empty when wt keeps no environment for it
  profiles: string[];
  setup: string | null;
  // when the idle watcher stopped it, in epoch seconds, until wt up restarts it
  asleep: number | null;
  services: ServiceState[];
}

export interface BaseEntry {
  repo: string;
  path: string;
  setup: string | null;
  services: ServiceState[];
  sharedBy: number;
}

const setupOf = (v: string) => (v ? setupLabel(v)[0] : null);

// every worktree of every known repo, with its environment, and the running base checkouts
export function lsData() {
  const sims = simDevices();
  const ports = listenPorts();
  const avds = runningAvds();
  const found = knownRepos().flatMap(worktreesOf);
  const worktrees: WorktreeEntry[] = names().map((n) => {
    const u = get(n, 'sim');
    const device = (kind: string) =>
      kind === 'sim' ? (u ? simState(u, sims).toLowerCase() : 'off') : avds.includes(n) ? 'booted' : 'off';
    const repo = get(n, 'repo');
    const path = get(n, 'path') || wtPath(repo, n);
    const git = found.find((w) => w.repo === repo && w.path === canonical(path));
    const t = Number(get(n, 'asleep'));
    return {
      ...git,
      repo,
      name: n,
      path,
      profiles: words(get(n, 'profiles')),
      setup: setupOf(runningUp(n) ? 'running' : get(n, 'setup')),
      asleep: t && !sessAlive(n) ? t : null,
      services: serviceStates(n, (p) => ports.has(p), device),
    };
  });
  const kept = new Set(worktrees.map((w) => canonical(w.path)));
  for (const w of found) {
    if (!kept.has(w.path)) worktrees.push({ ...w, profiles: [], setup: null, asleep: null, services: [] });
  }
  const bases: BaseEntry[] = [];
  for (const rp of registry) {
    if (!rp.base || !sessAlive(baseSession(rp))) continue;
    bases.push({
      repo: rp.repo!,
      path: rp.base,
      setup: setupOf(get(baseState(rp), 'setup')),
      services: shareable(rp, Object.keys(rp.services)).map((s) => {
        const p = basePorts(rp).listen(s);
        return { name: s, port: p, state: ports.has(p) ? 'running' : 'starting' };
      }),
      sharedBy: names().filter((n) => get(n, 'repo') === rp.repo && get(n, 'shares')).length,
    });
  }
  return { worktrees, bases };
}

const clock = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);

export function cmdLs(args: string[]) {
  const data = lsData();
  if (args.includes('--json')) {
    out(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  const rows: Row[] = data.worktrees.map((e) => ({
    repo: short(e.repo),
    name: e.branch || (e.detached ? `${e.name} (detached)` : e.name),
    profiles: e.profiles.join(' '),
    setup: e.setup ?? '',
    services: e.prunable !== undefined
      ? [`prunable${e.prunable ? `: ${e.prunable}` : ''}`]
      : !e.profiles.length
      ? ['not set up']
      : e.asleep
        ? [`asleep since ${clock(e.asleep)} (wakes on the next prompt or wt up)`]
        : e.services.map(label),
  }));
  for (const b of data.bases) {
    rows.push({ repo: short(b.repo), name: 'base', profiles: '', setup: b.setup ?? '', services: [...b.services.map(label), `shared by ${b.sharedBy}`] });
  }
  const tty = !!process.stdout.isTTY;
  out(table(rows, tty ? process.stdout.columns : Infinity, tty));
  return 0;
}
