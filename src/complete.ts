import { profileFor, profileNames, shareable } from './profile.ts';
import { SHELLS } from './shell.ts';
import { out } from './util.ts';
import { knownRepos, repoHere, worktreeAt, worktreesOf, type Wt } from './worktree.ts';

const COMMANDS = ['up', 'down', 'ls', 'path', 'cd', 'attach', 'logs', 'restart', 'open', 'grid', 'build', 'clean', 'shell-init'];

// the words shell completion offers after args: worktrees of the current repo (of every known
// repo outside one) under the label wt ls shows, and what the command takes for the worktree
// named in args or the current one
export function completions(args: string[], cwd = process.cwd()) {
  const [cmd, ...rest] = args;
  if (!cmd) return COMMANDS;
  const here = worktreeAt(cwd);
  const repo = here?.repo ?? repoHere(cwd);
  const all = (repo ? [repo] : knownRepos()).flatMap(worktreesOf);
  const label = (w: Wt) => w.branch || w.name;
  const target = all.find((w) => rest.includes(label(w)) || rest.includes(w.name));
  const w = target ?? here;
  const rp = w ? profileFor(w.repo, w.path) : repo ? profileFor(repo) : undefined;
  const selectors = (keep: (w: Wt) => boolean = () => true) => (target ? [] : all.filter(keep).map(label));
  // a command that also takes keywords targets the current worktree, so inside one only its keywords are offered
  const others = (keep?: (w: Wt) => boolean) => (here ? [] : selectors(keep));
  const services = rp ? Object.keys(rp.services).filter((s) => !rp.services[s].device) : [];
  let words: string[];
  switch (cmd) {
    case 'up':
      words = [...others(), ...(rp ? [...profileNames(rp), ...shareable(rp, Object.keys(rp.services))] : [])];
      break;
    case 'attach':
      words = [...others(), 'dev', 'up', ...services];
      break;
    case 'logs':
      words = [...others(), ...services, 'all', 'up', ...(rp?.base ? ['share'] : []), ...(rp?.logs === 'pane' ? ['dev'] : []), '-f'];
      break;
    case 'build':
      words = [...others((x) => !!profileFor(x.repo).mobile), 'ios', 'android'];
      break;
    case 'clean':
      words = [...selectors(), '--yes', '--force', '--no-fetch', '--min-age'];
      break;
    case 'ls':
      words = ['--json'];
      break;
    case 'shell-init':
      words = SHELLS;
      break;
    case 'down':
    case 'path':
    case 'cd':
    case 'open':
    case 'restart':
      words = selectors();
      break;
    default:
      words = [];
  }
  return [...new Set(words)].filter((x) => !rest.includes(x));
}

export function cmdComplete(args: string[]) {
  const words = completions(args);
  if (words.length) out(`${words.join('\n')}\n`);
  return 0;
}
