import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { clean, type Facts, type Io } from '../src/clean.ts';
import { readSessions, sessionDirs } from '../src/procs.ts';
import { registry, type RepoProfile } from '../src/profile.ts';
import type { WorktreeEntry } from '../src/inspect.ts';
import { field, payload } from '../src/hooks.ts';
import { upRequest } from '../src/up.ts';
import { completions } from '../src/complete.ts';

// real paths, as git and desktop sessions report them
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'wt-git-')));

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.exitCode) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

// a clone of a bare origin with main pushed; worktrees go under .claude/worktrees
function repo() {
  const d = tmp();
  git(d, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(d, 'clone', '-q', join(d, 'origin.git'), 'repo');
  const r = join(d, 'repo');
  git(r, 'checkout', '-q', '-b', 'main');
  commit(r, 'base');
  git(r, 'push', '-q', '-u', 'origin', 'main');
  git(r, 'remote', 'set-head', 'origin', 'main');
  return r;
}

const wtDir = (r: string, n: string) => join(r, '.claude/worktrees', n);

function worktree(r: string, n: string) {
  git(r, 'worktree', 'add', '-q', '-b', n, wtDir(r, n), 'main');
  return wtDir(r, n);
}

function io() {
  let text = '';
  const o: Io & { text: () => string } = {
    out: (s) => void (text += s),
    err: (s) => void (text += s),
    color: false,
    text: () => text,
  };
  return o;
}

const row = (text: string, kind: string, name: string) =>
  text
    .split('\n')
    .find((l) => new RegExp(`^${kind}\\s+${name}\\s`).test(l.trim()))
    ?.replace(/\s+/g, ' ')
    .trim();

describe('clean', () => {
  let r: string;
  let facts: Partial<Facts>;
  const home = process.env.WT_HOME!;
  const pruned = (text: string, name: string) => new RegExp(`^○ ${name} `, 'm').test(text);
  const locks = () => git(r, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('locked'));

  beforeAll(() => {
    r = repo();
    // merged by ancestry
    commit(worktree(r, 'merged'), 'm');
    git(r, 'merge', '-q', '--ff-only', 'merged');
    // squash-merged: main holds the same change as a different commit
    commit(worktree(r, 'squashed'), 's');
    git(r, 'cherry-pick', '-n', 'squashed');
    git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'squash');
    git(r, 'push', '-q', 'origin', 'main');
    // never pushed
    commit(worktree(r, 'local'), 'l');
    // merged but dirty, and merged but an agent works in it
    worktree(r, 'dirty');
    writeFileSync(join(wtDir(r, 'dirty'), 'scratch'), 'x');
    worktree(r, 'busy');
    worktree(r, 'agent');
    // a leftover dir that is not a worktree, and an environment whose worktree is gone
    mkdirSync(join(r, '.claude/worktrees/orphan'), { recursive: true });
    mkdirSync(join(home, 'ghost'), { recursive: true });
    writeFileSync(join(home, 'ghost/repo'), `${r}\n`);
    // DerivedData whose workspaces are gone: a stale one, and a builder's build cache
    const dd = tmp();
    mkdirSync(join(dd, 'Stale-abc'));
    mkdirSync(join(dd, 'wt-builder'));
    registry.push({ repo: '/nowhere', mobile: { builderDerived: join(dd, 'wt-builder') } } as unknown as RepoProfile);
    facts = {
      procs: [{ pid: '1', cmd: 'codex', tty: '??', cwd: wtDir(r, 'agent') }],
      derived: ['Stale-abc', 'wt-builder'].map((d) => ({ dir: join(dd, d), workspace: join(dd, 'gone', d, 'App.xcworkspace') })),
      sessions: [{ title: 'busy one', cwd: wtDir(r, 'busy'), branches: [], folders: [], active: 0 }],
    };
  });

  afterAll(() => {
    registry.pop();
  });

  test('the dry run keeps worktrees in use, lists what prune and the leftovers would take, and changes nothing', async () => {
    const o = io();
    expect(await clean(['--no-fetch', '--min-age=0s'], r, o, facts)).toBe(0);
    const t = o.text();
    expect(t).toContain('dry run — nothing will change');
    expect(row(t, 'worktree', 'busy')).toBe('worktree busy in use — session "busy one" is not archived');
    expect(row(t, 'worktree', 'agent')).toBe('worktree agent in use — codex (pid 1) is running in it');
    for (const n of ['merged', 'squashed']) expect(pruned(t, n)).toBe(true);
    for (const n of ['local', 'dirty', 'busy', 'agent']) expect(pruned(t, n)).toBe(false);
    expect(row(t, 'orphan dir', 'orphan')).toStartWith('orphan dir orphan not a git worktree,');
    expect(row(t, 'wt env', 'ghost')).toStartWith('wt env ghost worktree gone');
    expect(row(t, 'derived', 'Stale-abc')).toBeDefined();
    expect(row(t, 'derived', 'wt-builder')).toBeUndefined();
    expect(existsSync(wtDir(r, 'merged'))).toBe(true);
    expect(locks()).toEqual([]);
  });

  test('scan mode refuses when the session files cannot be read', async () => {
    const o = io();
    expect(await clean(['--no-fetch'], r, o, { ...facts, sessions: undefined })).toBe(1);
    expect(o.text()).toContain('cannot read desktop sessions');
  });

  test('a named dirty worktree is refused, then removed with --force', async () => {
    expect(await clean(['dirty'], r, io(), facts)).toBe(1);
    expect(existsSync(wtDir(r, 'dirty'))).toBe(true);
    expect(await clean(['dirty', '--force'], r, io(), facts)).toBe(0);
    expect(existsSync(wtDir(r, 'dirty'))).toBe(false);
  });

  test('an unknown name is refused', async () => {
    const o = io();
    expect(await clean(['nope'], r, o, facts)).toBe(1);
    expect(o.text()).toContain('No branch named nope');
  });

  test('--yes removes the merged worktrees and leftovers, keeps the rest, and leaves no lock', async () => {
    expect(await clean(['--yes', '--no-fetch', '--min-age=0s'], r, io(), facts)).toBe(0);
    for (const gone of ['merged', 'squashed', 'orphan']) expect(existsSync(wtDir(r, gone))).toBe(false);
    for (const kept of ['local', 'busy', 'agent']) expect(existsSync(wtDir(r, kept))).toBe(true);
    const branches = git(r, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    expect(branches.split('\n').sort()).toEqual(['agent', 'busy', 'local', 'main']);
    expect(existsSync(join(home, 'ghost'))).toBe(false);
    expect(existsSync(facts.derived![0].dir)).toBe(false);
    expect(existsSync(facts.derived![1].dir)).toBe(true);
    expect(locks()).toEqual([]);
  }, 20_000);
});

describe('desktop sessions', () => {
  test('archived ones are skipped, branches gathered, a broken file refuses', () => {
    const d = tmp();
    mkdirSync(join(d, 'x'));
    writeFileSync(
      join(d, 'x/local_1.json'),
      JSON.stringify({ title: 'a', cwd: '/w/a', branch: 'b1', writtenBranches: ['b2'], shellFolders: ['/w/b'], lastActivityAt: 5000, lastFocusedAt: 9000 }),
    );
    writeFileSync(join(d, 'local_2.json'), JSON.stringify({ title: 'z', cwd: '/w/z', isArchived: true }));
    expect(readSessions([d])).toEqual([{ title: 'a', cwd: '/w/a', branches: ['b1', 'b2'], folders: ['/w/b'], active: 9 }]);
    writeFileSync(join(d, 'local_3.json'), '{');
    expect(readSessions([d])).toBeUndefined();
    expect(readSessions([])).toEqual([]);
  });
  test('every claude app profile keeps its own sessions, and they are read together', () => {
    const home = tmp();
    const app = join(home, 'Library/Application Support');
    for (const p of ['Claude-Work', 'Claude-Personal']) {
      mkdirSync(join(app, p, 'claude-code-sessions'), { recursive: true });
      writeFileSync(join(app, p, 'claude-code-sessions/local_1.json'), JSON.stringify({ title: p, cwd: `/w/${p}` }));
    }
    mkdirSync(join(app, 'Claude-Cache'));
    const dirs = sessionDirs(home);
    expect(dirs.sort()).toEqual([join(app, 'Claude-Personal/claude-code-sessions'), join(app, 'Claude-Work/claude-code-sessions')]);
    expect(readSessions(dirs)?.map((s) => s.title).sort()).toEqual(['Claude-Personal', 'Claude-Work']);
    expect(sessionDirs(join(home, 'absent'))).toEqual([]);
  });
});

describe('hooks', () => {
  const main = join(import.meta.dir, '../src/main.ts');
  const hook = (event: string, input: object) =>
    Bun.spawnSync([process.execPath, main, 'hook', event], { stdin: Buffer.from(JSON.stringify(input)), env: process.env });

  test('payload fields: the first non-empty string wins', () => {
    const j = payload('{"worktree_path":"","path":"/p","n":1}');
    expect(field(j, 'worktree_path', 'path')).toBe('/p');
    expect(field(j, 'n')).toBeUndefined();
    expect(payload('not json')).toEqual({});
  });

  test('create prints only the new path, branches off freshly fetched origin, and copies .worktreeinclude', async () => {
    const r = repo();
    writeFileSync(join(r, '.gitignore'), '.env.local\n');
    writeFileSync(join(r, '.env.local'), 'SECRET=1\n');
    writeFileSync(join(r, '.worktreeinclude'), '.env.local\n');
    // origin moves on after the clone last fetched
    const other = join(r, '..', 'other');
    git(join(r, '..'), 'clone', '-q', 'origin.git', 'other');
    const ahead = commit(other, 'ahead');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    const res = hook('create', { name: 'feat', cwd: r });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe(`${wtDir(r, 'feat')}\n`);
    expect(git(wtDir(r, 'feat'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(git(r, 'rev-parse', 'feat')).toBe(ahead);
    // the copy runs as a background post-start hook
    const env = join(wtDir(r, 'feat'), '.env.local');
    for (let i = 0; i < 50 && !existsSync(env); i++) await Bun.sleep(100);
    expect(readFileSync(env, 'utf8')).toBe('SECRET=1\n');
  }, 20_000);

  test('create checks out a branch that already exists', () => {
    const r = repo();
    git(r, 'branch', 'old');
    const res = hook('create', { name: 'old', cwd: r });
    expect(res.exitCode).toBe(0);
    expect(git(wtDir(r, 'old'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('old');
  });

  test('remove takes a merged worktree with its branch, and refuses a dirty one', () => {
    const r = repo();
    const merged = worktree(r, 'gone');
    expect(hook('remove', { worktree_path: merged }).exitCode).toBe(0);
    expect(existsSync(merged)).toBe(false);
    expect(git(r, 'branch', '--list', 'gone')).toBe('');
    const dirty = worktree(r, 'kept');
    writeFileSync(join(dirty, 'scratch'), 'x');
    expect(hook('remove', { worktree_path: dirty }).exitCode).toBe(1);
    expect(existsSync(dirty)).toBe(true);
  });

  test('a prompt wakes an environment the idle watcher stopped, and ignores a worktree without one', () => {
    const r = repo();
    const p = worktree(r, 'sleepy');
    const st = join(process.env.WT_HOME!, 'sleepy');
    mkdirSync(st, { recursive: true });
    for (const [k, v] of [['repo', r], ['path', p], ['profiles', 'bare'], ['asleep', '1']]) writeFileSync(join(st, k), `${v}\n`);
    const res = hook('prompt', { cwd: p });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain('restarting in the background');
    expect(existsSync(join(st, 'asleep'))).toBe(false);
    expect(existsSync(join(st, 'active'))).toBe(true);
    const bare = worktree(r, 'plain');
    expect(hook('prompt', { cwd: bare }).stdout.toString()).toBe('');
    expect(existsSync(join(process.env.WT_HOME!, 'plain'))).toBe(false);
  });

  test('create without a name fails', () => {
    const res = hook('create', { cwd: '/tmp' });
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain('WorktreeCreate payload has no name');
  });
});

describe('discovery', () => {
  const main = join(import.meta.dir, '../src/main.ts');
  const wt = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, main, ...args], { cwd, env: process.env });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  // the rows under a repo's heading
  const section = (text: string, repo: string) => {
    const ls = text.split('\n');
    const i = ls.indexOf(repo);
    if (i < 0) return [];
    const end = ls.indexOf('', i);
    return ls.slice(i + 1, end < 0 ? undefined : end).map((l) => l.trim().replace(/\s+/g, ' '));
  };

  // a worktree another tool made, outside .claude/worktrees
  function foreign(name: string) {
    const r = repo();
    const p = join(r, '..', 'elsewhere', name);
    git(r, 'worktree', 'add', '-q', '-b', name, p, 'main');
    return { r, p };
  }

  test('ls lists a worktree wt keeps no state for once wt has run in its repo', () => {
    const { r } = foreign('disc-ls');
    const away = tmp();
    expect(section(wt(away, 'ls').out, r)).toEqual([]);
    expect(wt(r, 'ls').code).toBe(0);
    expect(section(wt(away, 'ls').out, r)).toEqual(['disc-ls - - not set up']);
  }, 20_000);

  test('ls --json gives each worktree with its environment, or none', () => {
    const { r, p } = foreign('disc-json');
    const st = join(process.env.WT_HOME!, 'disc-json-env');
    mkdirSync(st, { recursive: true });
    for (const [k, v] of [['repo', r], ['path', `${r}/x`], ['profiles', 'code'], ['setup', '0'], ['asleep', '1700000000']]) writeFileSync(join(st, k), `${v}\n`);
    const res = wt(r, 'ls', '--json');
    expect(res.code).toBe(0);
    const data = JSON.parse(res.out) as { worktrees: WorktreeEntry[]; bases: unknown[] };
    expect(data.worktrees.find((w) => w.name === 'disc-json')).toEqual({
      repo: r,
      name: 'disc-json',
      path: p,
      branch: 'disc-json',
      head: git(p, 'rev-parse', 'HEAD'),
      detached: false,
      profiles: [],
      setup: null,
      asleep: null,
      services: [],
    });
    expect(data.worktrees.find((w) => w.name === 'disc-json-env')).toEqual({
      repo: r,
      name: 'disc-json-env',
      path: `${r}/x`,
      profiles: ['code'],
      setup: 'ok',
      asleep: 1700000000,
      services: [],
    });
    expect(data.bases).toEqual([]);
  }, 20_000);

  test('the main checkout is not listed as a worktree', () => {
    const { r } = foreign('disc-main');
    expect(section(wt(r, 'ls').out, r)).toEqual(['disc-main - - not set up']);
  });

  test('path resolves a foreign worktree by name, and from a directory inside it', () => {
    const { r, p } = foreign('disc-path');
    expect(wt(r, 'path', 'disc-path').out).toBe(`${p}\n`);
    mkdirSync(join(p, 'sub'));
    expect(wt(join(p, 'sub'), 'path').out).toBe(`${p}\n`);
    expect(wt(tmp(), 'path', 'disc-path').out).toBe(`${p}\n`);
  });

  test('the main checkout resolves from inside it, a non-repo does not', () => {
    const { r } = foreign('disc-none');
    expect(wt(r, 'path').out).toBe(`${r}\n`);
    mkdirSync(join(r, 'sub'));
    expect(wt(join(r, 'sub'), 'path').out).toBe(`${r}\n`);
    expect(wt(tmp(), 'path').code).toBe(1);
  });

  test('git discovers arbitrary paths with duplicate basenames and slash-containing branches', () => {
    const r = repo();
    const first = join(tmp(), 'first', 'apps');
    const second = join(tmp(), 'second', 'apps');
    git(r, 'worktree', 'add', '-q', '-b', 'feature/first', first, 'main');
    git(r, 'worktree', 'add', '-q', '-b', 'feature/second', second, 'main');
    const data = JSON.parse(wt(r, 'ls', '--json').out) as { worktrees: WorktreeEntry[] };
    const entries = data.worktrees.filter((w) => w.repo === r);
    expect(entries).toHaveLength(2);
    expect(entries.find((w) => w.path === first)?.branch).toBe('feature/first');
    expect(entries.find((w) => w.path === second)?.branch).toBe('feature/second');
    expect(new Set(entries.map((w) => w.name)).size).toBe(2);
    expect(wt(r, 'ls').out).toContain('feature/first');
    expect(wt(r, 'path', 'feature/second').out).toBe(`${second}\n`);
    mkdirSync(join(first, 'nested'));
    expect(wt(join(first, 'nested'), 'path').out).toBe(`${first}\n`);
    expect(wt(r, 'path', 'apps').code).toBe(1);
  });

  test('unknown selectors fail instead of inventing a worktree path', () => {
    const { r } = foreign('known-selector');
    const result = wt(r, 'path', 'unknown-selector');
    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown worktree');
  });

  test('saved environments are joined by path without duplicating git entries', () => {
    const { r, p } = foreign('joined-path');
    const st = join(process.env.WT_HOME!, 'saved-environment');
    mkdirSync(st, { recursive: true });
    for (const [k, v] of [['repo', r], ['path', p], ['profiles', 'code'], ['setup', '0']]) writeFileSync(join(st, k), `${v}\n`);
    const data = JSON.parse(wt(r, 'ls', '--json').out) as { worktrees: WorktreeEntry[] };
    expect(data.worktrees.filter((w) => w.path === p)).toHaveLength(1);
    expect(data.worktrees.find((w) => w.path === p)?.name).toBe('saved-environment');
    expect(wt(r, 'path', 'joined-path').out).toBe(`${p}\n`);
  });

  test('up selects checkout app services instead of inventing another worktree', () => {
    const r = repo();
    const p = worktree(r, 'service-selection');
    mkdirSync(join(p, 'apps', 'retell'), { recursive: true });
    writeFileSync(join(p, 'apps', 'retell', 'package.json'), JSON.stringify({ name: '@test/retell', scripts: { dev: 'next dev' } }));
    registry.push({
      repo: r, name: 'service-selection', profiles: { code: [] }, services: {}, logs: 'turbo',
      setup: async () => 0,
      dev: () => '',
    });
    const selected = upRequest(['retell'], p);
    expect(selected.w.path).toBe(p);
    expect(selected.profs).toEqual(['retell']);
    expect(selected.rp.services.retell.pkg).toBe('@test/retell');
    expect(() => upRequest(['typo-service'], p)).toThrow('unknown profile or service');
    expect(upRequest(['service-selection', 'retell'], r).w.path).toBe(p);
    const main = upRequest(['code'], r);
    expect(main.w).toMatchObject({ repo: r, path: r, name: basename(r) });
    expect(main.profs).toEqual(['code']);
  });

  test('completion offers the current repo only: worktrees by ls label, the profile builder hidden, and inside a worktree only its keywords for up', () => {
    const r = repo();
    const other = repo();
    const p = worktree(r, 'complete-here');
    const renamed = wtDir(r, 'complete-dir');
    git(r, 'worktree', 'add', '-q', '-b', 'complete/branch', renamed, 'main');
    const builder = join(tmp(), 'builder');
    git(r, 'worktree', 'add', '-q', '--detach', builder, 'main');
    const base = join(tmp(), 'base');
    git(r, 'worktree', 'add', '-q', '--detach', base, 'main');
    worktree(other, 'complete-elsewhere');
    registry.push({
      repo: r, name: 'complete', profiles: { ios: ['sim'] }, services: { sim: { device: 'sim' } }, logs: 'turbo', base,
      setup: async () => 0,
      dev: () => '',
      mobile: { builder } as RepoProfile['mobile'],
    });
    expect(completions(['cd'], r).sort()).toEqual(['complete-here', 'complete/branch']);
    expect(completions(['up'], r)).toEqual(['complete/branch', 'complete-here', 'bare', 'code', 'ios']);
    expect(completions(['up'], p)).toEqual(['bare', 'code', 'ios']);
    expect(completions(['up', 'ios'], p)).toEqual(['bare', 'code']);
    expect(completions(['up', 'complete/branch'], r)).toEqual(['bare', 'code', 'ios']);
    expect(completions(['cd'], p).sort()).toEqual(['complete-here', 'complete/branch']);
  });

  test('a worktree directory named after its repo, as codex lays them out, is named after its parent', () => {
    const r = repo();
    const p = join(tmp(), 'feature-x', basename(r));
    git(r, 'worktree', 'add', '-q', '-b', 'codex/feature-x', p, 'main');
    expect(wt(r, 'path', 'feature-x').out).toBe(`${p}\n`);
  });

  test('git metadata survives detached, locked and missing worktree directories', () => {
    const r = repo();
    const p = join(tmp(), 'space in path');
    git(r, 'worktree', 'add', '-q', '--detach', p, 'main');
    git(r, 'worktree', 'lock', '--reason', 'test lock', p);
    const first = JSON.parse(wt(r, 'ls', '--json').out) as { worktrees: WorktreeEntry[] };
    expect(first.worktrees.find((w) => w.path === p)).toMatchObject({ detached: true, locked: 'test lock', head: git(r, 'rev-parse', 'HEAD') });
    git(r, 'worktree', 'unlock', p);
    rmSync(p, { recursive: true });
    const next = JSON.parse(wt(r, 'ls', '--json').out) as { worktrees: WorktreeEntry[] };
    expect(next.worktrees.find((w) => w.path === p)?.prunable).toBeString();
  });

  test('a bare repository owns its linked worktrees without a .git directory assumption', () => {
    const r = repo();
    const bare = join(r, '..', 'origin.git');
    const p = join(tmp(), 'bare-linked');
    git(bare, 'worktree', 'add', '-q', '-b', 'bare/feature', p, 'main');
    expect(wt(p, 'path').out).toBe(`${p}\n`);
    expect(wt(p, 'path', 'bare/feature').out).toBe(`${p}\n`);
  });
});
