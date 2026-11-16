import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configRepo, fromConfig, remoteId } from '../src/config.ts';
import { profileFor, registry, worktreePorts } from '../src/profile.ts';

function repo() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'wt-config-')));
  writeFileSync(join(r, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  writeFileSync(join(r, 'pnpm-lock.yaml'), '');
  for (const [name, dev] of [['api', 'node server.js'], ['web', 'vite']]) {
    mkdirSync(join(r, 'apps', name), { recursive: true });
    writeFileSync(join(r, 'apps', name, 'package.json'), JSON.stringify({ name: `@shop/${name}`, scripts: { dev } }));
  }
  return r;
}

const load = (r: string, toml: string) => {
  registry.push(fromConfig('shop', Bun.TOML.parse(toml) as never, '/cfg', r));
  try {
    return profileFor(r);
  } finally {
    registry.pop();
  }
};

test('services get PORT on their configured port plus the slot, or one from the block, and reach each other by template', () => {
  const r = repo();
  const rp = load(r, `
[services.api]
package = "@shop/api"
port = 8000

[services.web]
env = { API_URL = "{api.url}" }
`);
  const w = { repo: r, name: 'n', path: r };
  const ports = worktreePorts(rp, 3);
  expect(rp.services.api.command!(w, ports)).toBe('cd apps/api && PORT=8003 exec pnpm run dev');
  const web = ports.listen('web');
  expect(web).toBeGreaterThanOrEqual(13000);
  expect(rp.services.web.command!(w, ports)).toBe(`cd apps/web && PORT=${web} API_URL=http://localhost:8003 exec pnpm run dev --port ${web} --strictPort`);
  expect(rp.profiles.api).toEqual(['api']);
});

test('a port named in files reaches the service through the file alone', () => {
  const r = repo();
  const rp = load(r, `
[services.api]
package = "@shop/api"
port = 8000
files."apps/api/.env.local" = { PORT = "{port}" }
`);
  const w = { repo: r, name: 'n', path: r };
  expect(rp.services.api.command!(w, worktreePorts(rp, 1))).toBe('cd apps/api && exec pnpm run dev');
  expect(readFileSync(join(r, 'apps/api/.env.local'), 'utf8')).toBe('# managed by wt\nPORT=8001\n');
});

test('a command of its own gets the env exported, and a service setup and the config dir are kept', () => {
  const r = repo();
  const rp = load(r, `
[services.app]
command = "cd app && exec bun run real"
setup = "{config}/prepare.sh"
`);
  const w = { repo: r, name: 'n', path: r };
  const port = worktreePorts(rp, 2).listen('app');
  expect(rp.services.app.command!(w, worktreePorts(rp, 2))).toBe(`export PORT=${port}; cd app && exec bun run real`);
  expect(rp.services.app.setup).toBe('/cfg/prepare.sh');
});

test('a remote matches the checkout whose origin it names, in any url form', () => {
  expect(remoteId('git@github.com:acme/shop.git')).toBe('github.com/acme/shop');
  expect(remoteId('https://user@github.com/acme/shop.git\n')).toBe('github.com/acme/shop');
  const mine = repo();
  const other = repo();
  for (const [r, url] of [[mine, 'git@github.com:acme/shop.git'], [other, 'https://github.com/acme/shop-admin.git']]) {
    Bun.spawnSync(['git', 'init', '-q', r]);
    Bun.spawnSync(['git', '-C', r, 'remote', 'add', 'origin', url]);
  }
  expect(configRepo({ remote: 'acme/shop' }, [other, mine])).toBe(mine);
  expect(configRepo({ remote: 'github.com/acme/shop' }, [other, mine])).toBe(mine);
  expect(configRepo({ remote: 'acme/missing' }, [other, mine])).toBeUndefined();
});
