import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WT_HOME } from './env.ts';

export class Die extends Error {}

export function die(msg: string): never {
  throw new Die(msg);
}

export function out(s: string) {
  process.stdout.write(s);
}

export function say(msg: string) {
  out(`${new Date().toTimeString().slice(0, 8)} ${msg}\n`);
}

// date '+%F %T'
export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${d.toTimeString().slice(0, 8)}`;
}

export const sleep = (ms: number) => Bun.sleep(ms);
export const now = () => Math.floor(Date.now() / 1000);

// everything written to stdout and stderr from here on is also appended to a log
export function tee(log: string) {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      appendFileSync(log, chunk);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CaptureOpts {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
}

// a quick command, output captured
export function capture(cmd: string, args: string[], o: CaptureOpts = {}): Captured {
  const r = spawnSync(cmd, args, {
    cwd: o.cwd,
    input: o.input,
    env: o.env ? { ...process.env, ...o.env } : process.env,
    encoding: 'utf8',
    stdio: o.stdio,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const ok = (cmd: string, args: string[], o: CaptureOpts = {}) => capture(cmd, args, o).code === 0;

// capture without blocking the event loop, for processes that serve while they wait
export async function exec(cmd: string, args: string[], o: { cwd?: string } = {}): Promise<Captured> {
  try {
    const p = Bun.spawn([cmd, ...args], { cwd: o.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  quiet?: boolean;
}

// a long command whose output streams through this process, so tee catches it; stdin is
// /dev/null unless input is given
export function run(cmd: string, args: string[], o: RunOpts = {}): Promise<number> {
  return new Promise((resolve) => {
    const pipe = o.quiet ? 'ignore' : 'pipe';
    const c = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      stdio: [o.input === undefined ? 'ignore' : 'pipe', pipe, pipe],
    });
    if (o.input !== undefined) c.stdin?.end(o.input);
    c.stdout?.on('data', (d) => process.stdout.write(d));
    c.stderr?.on('data', (d) => process.stderr.write(d));
    c.on('error', () => resolve(127));
    c.on('close', (code) => resolve(code ?? 1));
  });
}

// hands the terminal to a command and returns its exit code
export function interactive(cmd: string, args: string[], cwd?: string): number {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd }).status ?? 1;
}

// starts a command in a session of its own that outlives wt; output goes to a log fd or nowhere
export function detach(cmd: string, args: string[], o: { log?: number; cwd?: string } = {}) {
  const io = o.log ?? 'ignore';
  const c = spawn(cmd, args, { detached: true, cwd: o.cwd, stdio: ['ignore', io, io] });
  c.unref();
  return c.pid;
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// a word bash reads back as itself: printf %q leaves these alone, anything else is quoted
export function shq(s: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const lines = (s: string) => s.split('\n').filter((l) => l !== '');

// moves paths aside instantly and deletes them detached
export function trash(paths: string[], prefix = 'wt-trash') {
  if (!paths.length) return;
  const t = join(WT_HOME, '.trash', `${prefix}-${process.pid}-${Date.now()}`);
  mkdirSync(t, { recursive: true });
  for (const p of paths) {
    try {
      renameSync(p, `${t}/${basename(p)}`);
    } catch {}
  }
  detach('rm', ['-rf', t]);
  return t;
}
