// per-worktree dev environments for the git worktrees of any
// repo. a worktree's profiles decide what runs; each worktree gets its own ports and tmux
// session. a repo profile in profiles/<name>/index.ts adds services, devices and setup steps
import { cmdBuild } from './build.ts';
import { CORE } from './env.ts';
import { clean, stdio } from './clean.ts';
import { cmdAttach, cmdGrid, cmdLogs, cmdOpen, cmdPath, cmdRestart } from './commands.ts';
import { cmdComplete } from './complete.ts';
import { generic } from './generic.ts';
import { hookCreate, hookPrompt, hookRemove, hookSessionStart } from './hooks.ts';
import { cmdIdle } from './idle.ts';
import { cmdLs } from './inspect.ts';
import { allServiceNames, defaultRepo, loadProfiles, profileFor, profileNames, registry } from './profile.ts';
import { cmdShare } from './share.ts';
import { cmdShellInit, SHELLS } from './shell.ts';
import { cmdDown, cmdInternalUp, cmdUp, purge } from './up.ts';
import { capture, Die, die, out } from './util.ts';
import { registerRepo, repoHere, worktreeAt } from './worktree.ts';

function usage() {
  const repo = defaultRepo();
  const here = worktreeAt(process.cwd());
  const profiles = registry
    .map((p) => `profiles in ${p.repo}: ${profileNames(profileFor(p.repo!, here && here.repo === p.repo ? here.path : p.repo)).join(', ')}`)
    .join('\n');
  out(`usage: wt <command> [<name>] [args]

  up [<profile>...]     add profiles and start what they need (no profile: restore, or code)
  up <service>...       start checkout apps with dev scripts; shared services run from the worktree
  down                  stop the tmux session and shut the simulator and emulator down
  ls [--json]           every worktree of every repo wt has run in, with its environment
  path                  print the worktree's directory
  cd                    cd into the worktree's directory (needs wt shell-init)
  attach                attach to the dev tui (i types into a task, ctrl-z stops)
  logs <service> [-f]   print or follow one task's output; services: ${allServiceNames().join(' ')}, all, up, share
  restart               restart the worktree's runs
  open                  reopen the app on the worktree's simulator and emulator, pointed at its metro
  grid                  a new iterm window with one pane attached to each running worktree (up to 4)
  build [android]       build and cache the ios (or android) dev client for the worktree's fingerprint
  clean [...]           remove the current repo's stale worktrees, branches and leftovers
                        (wt clean --help); outside any repo, ${repo}'s
  shell-init [<shell>]  the wt cd function and completion for ${SHELLS.join(', ')}:
                        eval "$(wt shell-init)" in your shell's rc file
  hook <event>          claude code hooks: session-start, prompt, create, remove
  switch list remove merge step config
                        worktrunk's own commands, run by ${CORE}

${profiles}
profiles in any other repo: ${generic.describe}
<name> defaults to the worktree containing the current directory; a selector is an existing
path, branch, saved environment name or unambiguous directory name from Git's worktree list.
`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  await loadProfiles();
  const here = repoHere();
  if (here) registerRepo(here);
  const [c = '', ...a] = argv;
  const stdin = () => Bun.stdin.text();
  switch (c) {
    case 'up':
      return cmdUp(a);
    case '_up':
      return cmdInternalUp(a[0]);
    case '_share':
      return cmdShare(a[0]);
    case 'down':
      return cmdDown(a[0]);
    case '_idle':
      return cmdIdle(a[0]);
    case '_purge':
      purge(a[0]);
      return 0;
    case 'ls':
      return cmdLs(a);
    case 'path':
      return cmdPath(a[0]);
    case '_complete':
      return cmdComplete(a);
    case 'cd':
      die(`cd runs in your shell: add eval "$(wt shell-init)" to its rc file, or cd "$(wt path ${a[0] ?? ''})"`);
    case 'shell-init':
      return cmdShellInit(a[0]);
    case 'attach':
      return cmdAttach(a);
    case 'logs':
      return cmdLogs(a);
    case 'restart':
      return cmdRestart(a);
    case 'open':
      return cmdOpen(a[0]);
    case 'grid':
      return cmdGrid();
    case 'build':
      return cmdBuild(a);
    case 'clean':
      return clean(a, here ?? defaultRepo(), stdio());
    case 'hook':
      switch (a[0]) {
        case 'session-start':
          return hookSessionStart(await stdin());
        case 'create':
          return hookCreate(await stdin());
        case 'remove':
          return hookRemove(await stdin());
        case 'prompt':
          return hookPrompt(await stdin());
        default:
          die(`unknown hook: ${a[0] ?? ''}`);
      }
    case 'switch':
    case 'list':
    case 'remove':
    case 'merge':
    case 'step':
    case 'config':
      return capture(CORE, [c, ...a], { stdio: 'inherit' }).code;
    case '':
    case '-h':
    case '--help':
    case 'help':
      return usage();
    default:
      die(`unknown command: ${c} (wt --help)`);
  }
}

const flush = (s: NodeJS.WriteStream) => new Promise<void>((r) => s.write('', () => r()));

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Die)) throw e;
  process.stderr.write(`wt: ${e.message}\n`);
  code = 1;
}
await flush(process.stdout);
await flush(process.stderr);
process.exit(code);
