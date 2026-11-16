import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEnv } from '../src/envfiles.ts';
import { readConfig, WT_HOME } from '../src/env.ts';
import { mergedProfiles, servicesOf, type RepoProfile } from '../src/profile.ts';
import { slotFor } from '../src/slots.ts';
import { get, lock, put, runningUp, unlock } from '../src/state.ts';
import { taskLine, taskText, turboLog } from '../src/turbolog.ts';
import { Die, now, shq } from '../src/util.ts';
import { idleMinutes, sessionAt, tick } from '../src/idle.ts';
import { foreignDeps } from '../src/devices.ts';
import { purge } from '../src/up.ts';
import { table } from '../src/inspect.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'wt-'));

describe('profiles', () => {
  test('merged profiles drop bare unless nothing else is left', () => {
    expect(mergedProfiles('', [])).toBe('bare');
    expect(mergedProfiles('bare', [])).toBe('bare');
    expect(mergedProfiles('bare', ['code'])).toBe('code');
    expect(mergedProfiles('', ['code'])).toBe('code');
    expect(mergedProfiles('code', ['ios'])).toBe('code ios');
    expect(mergedProfiles('code ios', ['ios', 'code'])).toBe('code ios');
  });
  test('services keep profile order without repeats', () => {
    const rp = { profiles: { ios: ['api', 'metro', 'sim'], android: ['api', 'metro', 'emu'] } } as unknown as RepoProfile;
    expect(servicesOf(rp, 'code ios android')).toEqual(['api', 'metro', 'sim', 'emu']);
    expect(servicesOf(rp, 'code')).toEqual([]);
  });
});

describe('state', () => {
  test('values round-trip without their trailing newline', () => {
    put('st-a', 'profiles', 'code ios');
    expect(readFileSync(join(WT_HOME, 'st-a/profiles'), 'utf8')).toBe('code ios\n');
    expect(get('st-a', 'profiles')).toBe('code ios');
    expect(get('st-a', 'missing')).toBe('');
  });

  test('an up is running while its pid lives or its start is under a minute old', async () => {
    put('st-b', 'up.pid', `starting:${now()}`);
    expect(runningUp('st-b')).toBe(true);
    put('st-b', 'up.pid', `starting:${now() - 61}`);
    expect(runningUp('st-b')).toBe(false);
    put('st-b', 'up.pid', process.pid);
    expect(runningUp('st-b')).toBe(true);
    const dead = Bun.spawn(['true']);
    await dead.exited;
    put('st-b', 'up.pid', dead.pid);
    expect(runningUp('st-b')).toBe(false);
  });

  test('a lock whose holder died is taken over; a live holder times out', async () => {
    const l = join(tmp(), 'state');
    const dead = Bun.spawn(['true']);
    await dead.exited;
    mkdirSync(`${l}.lock`);
    writeFileSync(`${l}.lock/pid`, `${dead.pid}\n`);
    await lock(l, 3);
    expect(readFileSync(`${l}.lock/pid`, 'utf8').trim()).toBe(String(process.pid));
    await expect(lock(l, 1)).rejects.toBeInstanceOf(Die);
    unlock(l);
    expect(existsSync(`${l}.lock`)).toBe(false);
  });
});

describe('slots', () => {
  test('the lowest slot no worktree holds and nothing listens on', async () => {
    put('sl-held', 'slot', 1);
    // the generic dev port of slot 2 is taken by a server wt does not own
    expect(await slotFor('sl-new', (p) => p === 3002)).toBe(3);
    expect(get('sl-new', 'slot')).toBe('3');
    expect(await slotFor('sl-new', () => true)).toBe(3);
  });
});

describe('env files', () => {
  test('a missing or wt-written file is written whole', () => {
    const d = tmp();
    writeEnv(d, '.env.local', { PORT: '8001' });
    expect(readFileSync(join(d, '.env.local'), 'utf8')).toBe('# managed by wt\nPORT=8001\n');
    writeEnv(d, '.env.local', { PORT: '8002', URL: 'x' });
    expect(readFileSync(join(d, '.env.local'), 'utf8')).toBe('# managed by wt\nPORT=8002\nURL=x\n');
  });

  test('a file wt did not write keeps its other lines: keys are replaced in place or appended', () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'A=1\nPORT=8010\nB=2');
    writeEnv(d, '.env', { PORT: '8013', URL: 'http://localhost:8013' });
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('A=1\nPORT=8013\nB=2\nURL=http://localhost:8013\n');
  });
});

describe('turbo logs', () => {
  const log = [
    '[',
    '{"source":"turbo","level":"info","timestamp":1,"text":"• Packages in scope"},',
    '{"source":"@acme/mobile#dev","level":"stdout","timestamp":2,"text":"Bundled 1 module"},',
    '{"source":"@acme/backend#dev","level":"stdout","timestamp":3,"text":"line one\\nline two"},',
    '{"source":"@acme/mobile#dev","level":"stdout","timestamp":4,"text":"broken',
    '{"source":"@acme/mobile#dev","level":"stdout","timestamp":5,"text":"last"}',
    ']',
  ].join('\n');

  test('one task, or every task with its name', () => {
    expect(taskLine('[', '@acme/mobile')).toBeUndefined();
    const d = tmp();
    mkdirSync(join(d, '.turbo/logs'), { recursive: true });
    writeFileSync(join(d, '.turbo/logs/1000.json'), '[\n]');
    writeFileSync(join(d, '.turbo/logs/2000.json'), log);
    const f = turboLog(d)!;
    expect(f.endsWith('2000.json')).toBe(true);
    expect(taskText(f, '@acme/mobile')).toEqual(['Bundled 1 module', 'last']);
    expect(taskText(f)).toEqual([
      'turbo: • Packages in scope',
      '@acme/mobile#dev: Bundled 1 module',
      '@acme/backend#dev: line one\nline two',
      '@acme/mobile#dev: last',
    ]);
  });

  test('no log dir', () => {
    expect(turboLog(tmp())).toBeUndefined();
  });
});

describe('ls table', () => {
  const rows = [
    { repo: 'b', name: 'x', profiles: 'code', setup: '0', services: ['api :8001', 'platform :8011', 'metro :8082'] },
    { repo: 'a', name: 'longer-name', profiles: '', setup: '', services: [] },
  ];
  test('repos are headed sections in order, separated by a blank line', () => {
    const ls = table(rows, 70).split('\n');
    expect(ls.slice(1, 4)).toEqual(['', 'a', '  longer-name  -         -      no services']);
    expect(ls.slice(4, 7)).toEqual(['', 'b', '  x            code      ok     api :8001 · platform :8011']);
  });
  test('services wrap within their own column', () => {
    const ls = table(rows, 70).split('\n');
    expect(ls[7]).toBe(`${' '.repeat(32)}metro :8082`);
    expect(ls.every((l) => l.length <= 70)).toBe(true);
  });
  test('without a width, services stay on one line', () => {
    expect(table(rows)).toContain('api :8001 · platform :8011 · metro :8082');
  });
});

describe('idle', () => {
  const n = 'idle-tick';
  const quiet = { bundled: 0, sessionAt: 0, agentCpu: 100, focused: false };
  test('a first sample starts the clock; nothing new for the limit means sleep', () => {
    expect(tick(n, quiet, 1000, 1800)).toBe(false);
    expect(tick(n, quiet, 2000, 1800)).toBe(false);
    expect(tick(n, quiet, 2800, 1800)).toBe(true);
  });
  test('a new bundle, agent cpu over the threshold, the user on a device, or session activity each reset the clock', () => {
    expect(tick(n, { ...quiet, bundled: 1 }, 5000, 1800)).toBe(false);
    expect(get(n, 'active')).toBe('5000');
    expect(tick(n, { ...quiet, bundled: 1, agentCpu: 101 }, 6000, 1800)).toBe(false);
    expect(get(n, 'active')).toBe('5000');
    expect(tick(n, { ...quiet, bundled: 1, agentCpu: 105 }, 7000, 1800)).toBe(false);
    expect(get(n, 'active')).toBe('7000');
    expect(tick(n, { ...quiet, bundled: 1, agentCpu: 105, focused: true }, 9000, 1800)).toBe(false);
    expect(get(n, 'active')).toBe('9000');
    expect(tick(n, { ...quiet, bundled: 1, agentCpu: 105, sessionAt: 8900 }, 9500, 1800)).toBe(false);
    expect(get(n, 'active')).toBe('9500');
    expect(tick(n, { ...quiet, bundled: 1, agentCpu: 105, sessionAt: 8900 }, 11_300, 1800)).toBe(true);
  });
  test('the limit defaults to 240 minutes, and WT_IDLE_MINUTES overrides it', () => {
    const saved = process.env.WT_IDLE_MINUTES;
    delete process.env.WT_IDLE_MINUTES;
    expect(idleMinutes()).toBe(240);
    process.env.WT_IDLE_MINUTES = '0';
    expect(idleMinutes()).toBe(0);
    if (saved === undefined) delete process.env.WT_IDLE_MINUTES;
    else process.env.WT_IDLE_MINUTES = saved;
  });
  test('desktop sessions and cli transcripts count from any claude profile, not only the stock one', () => {
    const home = tmp();
    const w = '/w/feature';
    writeFileSync(join(home, '.claude.json'), '{}');
    const app = join(home, 'Library/Application Support');
    mkdirSync(join(app, 'Claude-Work/claude-code-sessions/x'), { recursive: true });
    writeFileSync(
      join(app, 'Claude-Work/claude-code-sessions/x/local_1.json'),
      JSON.stringify({ cwd: '/elsewhere', shellFolders: [`${w}/apps`], lastActivityAt: 5_000_000 }),
    );
    mkdirSync(join(app, 'Claude-Personal/claude-code-sessions'), { recursive: true });
    writeFileSync(join(app, 'Claude-Personal/claude-code-sessions/local_2.json'), JSON.stringify({ cwd: '/w/other', lastActivityAt: 9_000_000 }));
    expect(sessionAt(w, home)).toBe(5000);
    const t = join(home, '.claude-work/projects/-w-feature');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 's.jsonl'), '');
    utimesSync(join(t, 's.jsonl'), 7000, 7000);
    expect(sessionAt(w, home)).toBe(7000);
  });
});

describe('misc', () => {
  test('shq quotes only what bash would', () => {
    expect(shq('/a/b/wt _up x')).toBe(`'/a/b/wt _up x'`);
    expect(shq('PORT=8001')).toBe('PORT=8001');
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  test('config lines, quoted or not', () => {
    const f = join(tmp(), 'config');
    writeFileSync(f, '# comment\nWT_LOGIN_EMAIL="a@b.c"\nexport X=1\nbad line\n');
    expect(readConfig(f)).toEqual({ WT_LOGIN_EMAIL: 'a@b.c', X: '1' });
  });

  test('deps resolved outside the checkout are reported', () => {
    const other = tmp();
    mkdirSync(join(other, 'node_modules/.pnpm'), { recursive: true });
    const own = tmp();
    mkdirSync(join(own, 'node_modules/.pnpm'), { recursive: true });
    expect(foreignDeps(own)).toBeUndefined();
    expect(foreignDeps(tmp())).toBeUndefined();
    const linked = tmp();
    mkdirSync(join(linked, 'node_modules'));
    symlinkSync(join(other, 'node_modules/.pnpm'), join(linked, 'node_modules/.pnpm'));
    expect(foreignDeps(linked)).toBe(realpathSync(join(other, 'node_modules/.pnpm')));
    const whole = tmp();
    symlinkSync(join(other, 'node_modules'), join(whole, 'node_modules'));
    expect(foreignDeps(whole)).toBe(realpathSync(join(other, 'node_modules/.pnpm')));
  });

  test('build re-enters a login shell once', async () => {
    const env = { ...process.env };
    delete env.WT_LOGIN;
    delete env.WT_SELF;
    // its own process group, so a respawn loop can be killed whole
    const c = spawn(join(import.meta.dir, '..', 'wt'), ['build'], { cwd: tmp(), env, detached: true });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    const code = await Promise.race([
      new Promise<number | null>((r) => c.on('exit', r)),
      Bun.sleep(20000).then(() => 'timeout' as const),
    ]);
    if (code === 'timeout') process.kill(-c.pid!, 'SIGKILL');
    expect(code).toBe(1);
    expect(err).toContain('no profile has a dev client');
  }, 30000);
});

describe('purge', () => {
  test('takes only the environment saved for that path, never one that shares its name', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-purge-')));
    put('fix-ci', 'path', join(root, 'a/fix-ci'));
    put('fix-ci', 'repo', join(root, 'a'));
    purge(join(root, 'b/fix-ci'));
    expect(get('fix-ci', 'path')).toBe(join(root, 'a/fix-ci'));
    purge(join(root, 'a/fix-ci'));
    expect(existsSync(join(WT_HOME, 'fix-ci'))).toBe(false);
    expect(() => purge('fix-ci')).toThrow(Die);
  });
});
