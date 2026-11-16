import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './env.ts';
import { capture, detach, lines } from './util.ts';

export interface Proc {
  pid: string;
  cmd: string;
  tty: string;
  cwd: string;
}

// agents whose process standing in a worktree marks it in use
export const AGENTS = ['claude', 'codex'];

export const under = (path: string, dir: string) => `${path}/`.startsWith(`${dir}/`);

// every process standing in a directory: a claude one marks a worktree in use, and
// tty-less ones are stopped when their worktree goes
export function readProcs(): Proc[] {
  const tty = new Map<string, string>();
  for (const l of lines(capture('ps', ['-Ao', 'pid=,tty=']).stdout)) {
    const [pid, t] = l.trim().split(/\s+/);
    tty.set(pid, t);
  }
  const procs: Proc[] = [];
  let pid = '';
  let cmd = '';
  for (const l of lines(capture('lsof', ['-d', 'cwd', '-F', 'pcn']).stdout)) {
    if (l[0] === 'p') pid = l.slice(1);
    else if (l[0] === 'c') cmd = l.slice(1);
    else if (l[0] === 'n') procs.push({ pid, cmd, tty: tty.get(pid) ?? '', cwd: l.slice(1) });
  }
  return procs;
}

// stops tty-less processes standing in directories about to go. claude and tmux are never
// ours to stop, and neither is the chain running wt
export function stopLeftovers(dirs: string[], procs = readProcs()) {
  const anc = new Set<string>();
  for (let a = String(process.pid); a && Number(a) > 1; a = capture('ps', ['-o', 'ppid=', '-p', a]).stdout.trim()) anc.add(a);
  const pids = procs
    .filter((p) => ['?', '??'].includes(p.tty) && !['claude', 'disclaimer', 'tmux'].includes(p.cmd) && !anc.has(p.pid))
    .filter((p) => dirs.some((d) => under(p.cwd, d)))
    .map((p) => p.pid);
  if (!pids.length) return 0;
  for (const p of pids) {
    try {
      process.kill(Number(p), 'SIGTERM');
    } catch {}
  }
  // a server that ignores TERM must not outlive its worktree
  detach('bash', ['-c', `sleep 5; kill -9 ${pids.join(' ')} 2>/dev/null`]);
  return pids.length;
}

export interface Session {
  title: string;
  cwd: string;
  branches: string[];
  // folders its shell works in, which can differ from cwd
  folders: string[];
  // when it last did something or was looked at, in epoch seconds
  active: number;
}

// the existing `sub` folders of every directory in parent named prefix*, one per Claude profile
export const profileDirs = (parent: string, prefix: string, sub: string) =>
  existsSync(parent)
    ? readdirSync(parent)
        .filter((d) => d.startsWith(prefix))
        .map((d) => join(parent, d, sub))
        .filter((d) => existsSync(d))
    : [];

export const sessionDirs = (home = HOME) => profileDirs(join(home, 'Library/Application Support'), 'Claude', 'claude-code-sessions');

// desktop sessions that are not archived, with the branches they are on or wrote; none without
// the desktop app, undefined when a session file cannot be read
export function readSessions(dirs = sessionDirs()): Session[] | undefined {
  if (!dirs.length) return [];
  const files = capture('find', [...dirs, '-name', 'local_*.json']).stdout;
  const out: Session[] = [];
  try {
    for (const f of lines(files)) {
      const s = JSON.parse(readFileSync(f, 'utf8')) as {
        isArchived?: boolean;
        title?: string;
        cwd?: string;
        branch?: string;
        writtenBranches?: string[];
        shellFolders?: string[];
        lastActivityAt?: number;
        lastFocusedAt?: number;
      };
      if (s.isArchived === true) continue;
      out.push({
        title: s.title ?? 'untitled',
        cwd: s.cwd ?? '',
        branches: [...(s.branch ? [s.branch] : []), ...(s.writtenBranches ?? [])],
        folders: s.shellFolders ?? [],
        active: Math.floor(Math.max(s.lastActivityAt ?? 0, s.lastFocusedAt ?? 0) / 1000),
      });
    }
  } catch {
    return;
  }
  return out;
}
