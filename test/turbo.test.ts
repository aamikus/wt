import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor, registry, servicesOf, worktreePorts, type RepoProfile } from '../src/profile.ts';
import { put } from '../src/state.ts';
import { touched } from '../src/turbo.ts';

function app(dir: string, name: string, dev?: string) {
  const path = join(dir, 'apps', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: `@test/${name}`, scripts: { dev } }));
}

function workspace() {
  const repo = mkdtempSync(join(tmpdir(), 'wt-apps-'));
  const profile: RepoProfile = {
    repo, name: 'apps-test', profiles: {}, services: {}, logs: 'turbo',
    setup: async () => 0,
    dev: (_w, _services, _ports, pkgs) => `exec pnpm exec turbo run dev ${pkgs.map((p) => `-F ${p}`).join(' ')} --concurrency=64 --ui=tui --log-file`,
  };
  registry.push(profile);
  return repo;
}

test('checkout dev scripts become services with independent frontend ports', () => {
  const repo = workspace();
  app(repo, 'retell', 'next dev --experimental-https');
  app(repo, 'billing', 'next dev --port 3020');
  app(repo, 'assets');
  const rp = profileFor(repo);
  const w = { repo, name: 'apps-test', path: repo };
  const ports = worktreePorts(rp, 2);
  expect(servicesOf(rp, 'retell billing')).toEqual(['retell', 'billing']);
  expect(rp.services.assets).toBeUndefined();
  expect(ports.listen('retell')).not.toBe(ports.listen('billing'));
  for (const name of ['retell', 'billing']) {
    const command = rp.services[name].command!(w, ports)!;
    expect(command).toStartWith(`cd apps/${name} && `);
    expect(command).toContain('exec npm run dev -- --port');
    expect(command).toContain(`PORT=${ports.listen(name)}`);
    expect(command).toEndWith(`--port ${ports.listen(name)}`);
    expect(command).not.toContain('turbo');
  }
});

test('new apps keep existing service port assignments', () => {
  const repo = workspace();
  app(repo, 'retell', 'next dev');
  const first = profileFor(repo);
  put('apps-stable-ports', 'repo', repo);
  put('apps-stable-ports', 'path', repo);
  put('apps-stable-ports', 'ports', JSON.stringify({ '@test/retell': first.services.retell.portOffset }));
  app(repo, 'alphabetical-first', 'next dev');
  const next = profileFor(repo);
  expect(next.services.retell.port!(3)).toBe(first.services.retell.port!(3));
  expect(next.services['alphabetical-first'].port!(3)).not.toBe(next.services.retell.port!(3));
});

test('worker dev scripts run without pretending to listen on a web port', () => {
  const repo = workspace();
  app(repo, 'worker', 'node worker.js');
  const rp = profileFor(repo);
  const w = { repo, name: 'worker-test', path: repo };
  expect(rp.services.worker.port).toBeUndefined();
  expect(rp.services.worker.command!(w, worktreePorts(rp, 2))).toBe('cd apps/worker && exec npm run dev');
  expect(rp.services.worker.command!(w, worktreePorts(rp, 2))).not.toContain('--port');
});

test('vite servers use their allocated port without silently switching to another one', () => {
  const repo = workspace();
  app(repo, 'game', 'vite --port 3001');
  app(repo, 'bundle-watch', 'vite build --watch');
  const rp = profileFor(repo);
  const w = { repo, name: 'vite-test', path: repo };
  const ports = worktreePorts(rp, 2);
  expect(rp.services.game.command!(w, ports)).toEndWith(`--port ${ports.listen('game')} --strictPort`);
  expect(rp.services['bundle-watch'].port).toBeUndefined();
});

const pkgs = [
  { name: 'backend', path: 'apps/backend' },
  { name: 'mobile', path: 'apps/mobile' },
  { name: 'forge', path: 'apps/forge' },
  { name: 'forge-modal', path: 'apps/forge-modal' },
  { name: 'schemas', path: 'packages/schemas' },
];

test('a dependency added in one app marks that app alone, not every package', () => {
  expect(touched(['apps/mobile/package.json', 'pnpm-lock.yaml'], pkgs)).toEqual(['mobile']);
  expect(touched(['pnpm-lock.yaml'], pkgs)).toEqual([]);
});

test('files map to the package that contains them', () => {
  expect(touched(['apps/backend/src/a.ts', 'packages/schemas/src/b.ts', 'apps/forge-modal/x.ts'], pkgs)).toEqual([
    'backend',
    'schemas',
    'forge-modal',
  ]);
});

test('root files every package runs with mark all of them', () => {
  for (const f of ['package.json', 'pnpm-workspace.yaml', 'turbo.jsonc']) expect(touched([f], pkgs)).toBe('all');
});

test('docs, plans and ci config outside every package mark nothing', () => {
  expect(touched(['docs/a.md', 'plans/x/README.md', '.github/workflows/ci.yml', 'AGENTS.md'], pkgs)).toEqual([]);
});
