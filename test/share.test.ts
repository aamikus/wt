import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseState, ensureBase } from '../src/base.ts';
import { basePorts, registry, slotPorts, worktreePorts, type RepoProfile } from '../src/profile.ts';
import { proxy } from '../src/proxy.ts';
import { get } from '../src/state.ts';

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

// an http server that reads each request, then answers with its name and the body it got
function upstream(name: string, port = 0) {
  const s = http((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => res.end(body ? `${name}:${body}` : name));
  });
  servers.push(s as unknown as Server);
  return new Promise<number>((r) => s.listen(port, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
}

const portOf = (s: Server) => (s.address() as AddressInfo).port;
const get200 = (port: number) => fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } }).then((r) => r.text());

describe('proxy', () => {
  test('each connection goes where the target points when it arrives', async () => {
    const a = await upstream('a');
    const b = await upstream('b');
    let to = a;
    const p = await proxy(0, () => to);
    servers.push(p);
    expect(await get200(portOf(p))).toBe('a');
    to = b;
    expect(await get200(portOf(p))).toBe('b');
  });

  test('a request body sent before the target connects reaches it', async () => {
    const a = await upstream('a');
    const p = await proxy(0, () => a);
    servers.push(p);
    const r = await fetch(`http://127.0.0.1:${portOf(p)}/`, { method: 'POST', body: 'x'.repeat(100_000), headers: { connection: 'close' } });
    expect(await r.text()).toBe(`a:${'x'.repeat(100_000)}`);
  });

  test('a target that refuses is retried until it listens', async () => {
    const probe = createServer();
    const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r(portOf(probe))));
    await new Promise((r) => probe.close(r));
    const p = await proxy(0, () => port);
    servers.push(p);
    const answer = get200(portOf(p));
    await Bun.sleep(1200);
    await upstream('late', port);
    expect(await answer).toBe('late');
  });

  test('a client is dropped once the wait runs out', async () => {
    const probe = createServer();
    const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r(portOf(probe))));
    await new Promise((r) => probe.close(r));
    const p = await proxy(0, () => port, 600);
    servers.push(p);
    await expect(get200(portOf(p))).rejects.toThrow();
  });
});

const share: RepoProfile = {
  name: 'sharetest',
  profiles: { app: ['api', 'metro'] },
  describe: '',
  base: '/b',
  services: {
    api: { pkg: 'api', port: (k) => 8000 + k, reserves: true, share: '/health' },
    metro: { pkg: 'mobile', port: (k) => 8081 + k, reserves: true },
  },
  logs: 'pane',
  setup: async () => 0,
  dev: () => undefined,
};

describe('ports', () => {
  test('a shared service listens behind the proxy; the base takes slot 0 above it', () => {
    const p = worktreePorts(share, 3);
    expect([p.addr('api'), p.listen('api'), p.addr('metro'), p.listen('metro')]).toEqual([8003, 9003, 8084, 8084]);
    expect(basePorts(share).listen('api')).toBe(9000);
    expect(worktreePorts({ ...share, base: undefined }, 3).listen('api')).toBe(8003);
  });

  test('a slot reserves the own ports of shared services too', () => {
    registry.push(share);
    try {
      expect(slotPorts(3)).toEqual(expect.arrayContaining([8003, 9003, 8084]));
    } finally {
      registry.pop();
    }
  });
});

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.exitCode) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string, text = file) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('base freshness', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wt-base-')));
  git(d, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(d, 'clone', '-q', join(d, 'origin.git'), 'repo');
  const repo = join(d, 'repo');
  git(repo, 'checkout', '-q', '-b', 'main');
  const c1 = commit(repo, 'a');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  let setups = 0;
  const rp: RepoProfile = { ...share, name: `fresh${process.pid}`, repo, base: join(d, 'base'), setup: async () => (setups++, 0) };

  test('the first sharer creates the base on the default branch and sets it up', async () => {
    expect(await ensureBase(rp, c1)).toBe(true);
    expect(git(rp.base!, 'rev-parse', 'HEAD')).toBe(c1);
    expect(setups).toBe(1);
    expect(get(baseState(rp), 'setup')).toBe('0');
  });

  test('a worktree based on newer main moves the base forward, without a reinstall', async () => {
    const c2 = commit(repo, 'b');
    git(repo, 'push', '-q', 'origin', 'main');
    expect(await ensureBase(rp, c2)).toBe(true);
    expect(git(rp.base!, 'rev-parse', 'HEAD')).toBe(c2);
    expect(setups).toBe(1);
  });

  test('a dependency change on main sets the base up again', async () => {
    const c3 = commit(repo, 'package.json', '{}');
    git(repo, 'push', '-q', 'origin', 'main');
    expect(await ensureBase(rp, c3)).toBe(true);
    expect(setups).toBe(2);
  });

  test('a base newer than the worktree serves it as it is', async () => {
    expect(await ensureBase(rp, c1)).toBe(true);
    expect(git(rp.base!, 'rev-parse', 'HEAD')).not.toBe(c1);
  });

  test('a merge-base the default branch lacks cannot be served', async () => {
    git(repo, 'checkout', '-q', '-b', 'side');
    const local = commit(repo, 'c');
    git(repo, 'checkout', '-q', 'main');
    expect(await ensureBase(rp, local)).toBe(false);
    expect(existsSync(rp.base!)).toBe(true);
  });

  test('the base is locked against pruning, and one pruned anyway with files left behind is recreated', async () => {
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('locked wt base checkout');
    git(repo, 'worktree', 'unlock', rp.base!);
    git(repo, 'worktree', 'remove', '--force', rp.base!);
    mkdirSync(join(rp.base!, 'apps'), { recursive: true });
    const before = setups;
    expect(await ensureBase(rp, c1)).toBe(true);
    expect(existsSync(join(rp.base!, '.git'))).toBe(true);
    expect(setups).toBe(before + 1);
  });
});
