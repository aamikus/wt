// cleans up a repo's merged worktrees and branches through wtcore, keeping the ones agents
// are working in, plus the environments, build outputs and directories they leave behind
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve as abs } from 'node:path';
import { CORE, HOME } from './env.ts';
import { derivedData } from './devices.ts';
import { AGENTS, readProcs, readSessions, under, type Proc, type Session } from './procs.ts';
import { profileFor, registry } from './profile.ts';
import { get, names } from './state.ts';
import { purge } from './up.ts';
import { capture, trash } from './util.ts';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  color: boolean;
}

export interface Facts {
  procs: Proc[];
  // undefined when the session files could not be read
  sessions: Session[] | undefined;
  derived: { dir: string; workspace: string }[];
}

// a lock under this reason is clean's own, so a run that died holding it can be undone
const LOCK = 'wt clean: in use';

const USAGE = `usage: wt clean [<name>...] [--yes] [--force] [--no-fetch] [--min-age <age>]

  (no args)        report only, changes nothing
  <name>...        remove these worktrees or branches now; a dirty worktree refuses and an
                   unmerged branch stays
  --yes            remove everything listed
  --force          with <name>, drop uncommitted changes and unmerged branches too
  --no-fetch       skip git fetch --prune (faster, staler classification)
  --min-age <age>  skip worktrees and branches younger than this (default 1d)

a worktree is in use while a claude or codex process runs in it, or while a desktop session
that is not archived sits in it or wrote its branch. in-use worktrees are locked while
${CORE} prunes, so they stay.
`;

interface WtRow {
  path: string;
  branch: string;
  prunable: boolean;
  // the lock reason, '' when locked without one, undefined when not locked
  lock?: string;
}

// linked worktrees; git lists the main checkout first
function worktrees(root: string): WtRow[] {
  const rows: WtRow[] = [];
  for (const l of capture('git', ['worktree', 'list', '--porcelain'], { cwd: root }).stdout.split('\n')) {
    if (l.startsWith('worktree ')) rows.push({ path: l.slice(9), branch: '', prunable: false });
    else if (!rows.length) continue;
    else if (l.startsWith('branch ')) rows.at(-1)!.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l.startsWith('prunable')) rows.at(-1)!.prunable = true;
    else if (l.startsWith('locked')) rows.at(-1)!.lock = l.slice(7);
  }
  return rows.slice(1);
}

type Row = [kind: string, name: string, why: string];

export async function clean(args: string[], cwd: string, io: Io, given: Partial<Facts> = {}) {
  let apply = false;
  let force = false;
  let fetch = true;
  let minAge = '';
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-y' || a === '--yes') apply = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a === '--no-fetch') fetch = false;
    else if (a === '--min-age') minAge = args[++i] ?? '';
    else if (a.startsWith('--min-age=')) minAge = a.slice(10);
    else if (a === '-h' || a === '--help') {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith('-')) {
      io.err(`unknown option: ${a}\n`);
      return 2;
    } else targets.push(a);
  }

  const g = capture('git', ['rev-parse', '--git-common-dir'], { cwd });
  if (g.code) {
    io.err(g.stderr);
    return 1;
  }
  // git lists worktrees by their real path
  const root = dirname(realpathSync(abs(cwd, g.stdout.trim())));
  const wtdir = join(root, '.claude/worktrees');
  const git = (...a: string[]) => capture('git', a, { cwd: root });
  const core = (...a: string[]) => {
    const r = capture(CORE, a, { cwd: root });
    io.out(r.stderr + r.stdout);
    return r.code;
  };
  const wts = worktrees(root);

  // ---------------------------------------------------------------- selective mode

  if (targets.length) {
    let code = 0;
    for (const t of targets) {
      const name = t.replace(/\/$/, '');
      const w = wts.find((x) => basename(x.path) === name);
      if (core('remove', w?.path ?? name, '--foreground', ...(force ? ['--force', '-D'] : []))) code = 1;
    }
    return code;
  }

  // ---------------------------------------------------------------- scan mode

  const sessions = 'sessions' in given ? given.sessions : readSessions();
  if (!sessions) {
    io.err(`wt clean: cannot read desktop sessions in ~/Library/Application Support/Claude*/claude-code-sessions, so no worktree is known to be unused; name targets instead\n`);
    return 1;
  }
  if (fetch && git('fetch', '--quiet', '--prune', 'origin').code) io.err('wt clean: fetch failed, classifying against cached refs\n\n');
  const procs = given.procs ?? readProcs();

  const [red, green, bold, dim, off] = io.color ? ['\x1b[31m', '\x1b[32m', '\x1b[1m', '\x1b[2m', '\x1b[0m'] : ['', '', '', '', ''];

  // why the worktree at p on branch b is in use, if it is
  function inUse(p: string, b: string) {
    const c = procs.find((x) => AGENTS.includes(x.cmd) && under(x.cwd, p));
    if (c) return `${c.cmd} (pid ${c.pid}) is running in it`;
    const s = sessions?.find((x) => (x.cwd && under(x.cwd, p)) || (b && x.branches.includes(b)));
    if (s) return `session "${s.title}" is not archived`;
  }

  const staying: Row[] = [];
  const locked: string[] = [];
  for (const w of wts) {
    if (w.prunable) continue;
    if (w.lock?.startsWith(LOCK)) git('worktree', 'unlock', w.path);
    else if (w.lock !== undefined) continue;
    const why = inUse(w.path, w.branch);
    if (!why) continue;
    staying.push(['worktree', basename(w.path), `in use — ${why}`]);
    if (!git('worktree', 'lock', '--reason', `${LOCK} — ${why}`, w.path).code) locked.push(w.path);
  }

  const going: Row[] = [];
  // worktree names whose wt environment goes, and leftover paths outside any worktree
  const finalPurge: { name: string; path: string }[] = [];
  const finalLeftovers: string[] = [];

  const dirs = existsSync(wtdir) ? readdirSync(wtdir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  for (const e of dirs) {
    const d = join(wtdir, e.name);
    if (wts.some((w) => w.path === d)) continue;
    const why = inUse(d, '');
    if (existsSync(join(d, '.git'))) staying.push(['orphan dir', e.name, 'has a .git but git does not list it as a worktree']);
    else if (why) staying.push(['orphan dir', e.name, `in use — ${why}`]);
    else {
      finalLeftovers.push(d);
      finalPurge.push({ name: e.name, path: d });
      const size = capture('du', ['-sh', d]).stdout.split('\t')[0];
      going.push(['orphan dir', e.name, `not a git worktree, ${size} of leftovers`]);
    }
  }

  // this repo's wt environments whose worktree is already gone
  for (const n of names()) {
    const p = get(n, 'path') || join(wtdir, n);
    if (existsSync(p) || get(n, 'repo') !== root || finalPurge.some((w) => w.name === n)) continue;
    finalPurge.push({ name: n, path: p });
    going.push(['wt env', n, 'worktree gone, tmux session, simulator and emulator go too']);
  }

  // DerivedData whose workspace no longer exists, except a builder's, which is its incremental
  // build cache whether or not its workspace is there between builds
  const builders = registry.map((p) => p.mobile?.builderDerived);
  for (const d of given.derived ?? derivedData()) {
    if (existsSync(d.workspace) || builders.includes(d.dir)) continue;
    finalLeftovers.push(d.dir);
    going.push(['derived', basename(d.dir), `${d.workspace.replace(HOME, '~')} is gone`]);
  }

  // cached dev clients: the newest 3 stay, and any a simulator or emulator still runs
  const m = profileFor(root).mobile;
  if (m && existsSync(m.cacheDir)) {
    const inUseFps = new Set(names().flatMap((n) => [get(n, 'sim.fp'), get(n, 'emu.fp')]).filter(Boolean));
    const builds = readdirSync(m.cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, mtime: statSync(join(m.cacheDir, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const b of builds.slice(3)) {
      if (inUseFps.has(b.name)) continue;
      let built = '';
      try {
        built = readFileSync(join(m.cacheDir, b.name, 'built'), 'utf8').split(' ')[0];
      } catch {}
      finalLeftovers.push(join(m.cacheDir, b.name));
      going.push(['dev client', b.name, `older build, built ${built}`]);
    }
  }

  const line = (kind: string, name: string, why: string) => `  ${kind.padEnd(11)} ${name.padEnd(40)} ${dim}${why}${off}\n`;
  const section = (title: string, colour: string, rows: Row[]) => {
    io.out(`${colour}${bold}${title}${off}\n`);
    if (!rows.length) io.out(`  ${dim}(nothing)${off}\n`);
    for (const [kind, name, why] of rows) io.out(line(kind, name, why));
    io.out('\n');
  };

  io.out(apply ? `\n${bold}applying${off}\n\n` : `\n${bold}dry run — nothing will change${off}\n\n`);
  section('keeping (untouched)', green, staying);
  io.out(`${red}${bold}merged worktrees and branches (${CORE} step prune)${off}\n`);
  try {
    core('step', 'prune', apply ? '--foreground' : '--dry-run', ...(minAge ? [`--min-age=${minAge}`] : []));
  } finally {
    for (const p of locked) git('worktree', 'unlock', p);
  }
  io.out('\n');
  section('leftovers', red, going);

  if (!apply) {
    io.out(`${dim}pass --yes to apply, or name targets: wt clean <name>...${off}\n`);
    return 0;
  }
  // purge first: DerivedData is matched by the worktree path before the dir moves away
  for (const w of finalPurge) purge(w.name, root, w.path);
  if (finalLeftovers.length) {
    const t = trash(finalLeftovers, 'wt-clean');
    io.out(`removed ${finalLeftovers.length} leftover(s), ${t} deleting in the background\n`);
  }
  return 0;
}

export const stdio = (): Io => ({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  color: !!process.stdout.isTTY,
});
