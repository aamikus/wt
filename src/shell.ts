import { basename } from 'node:path';
import { die, out } from './util.ts';

// wt cd needs a shell function, since a child process cannot change its shell's directory
const SNIPPETS: Record<string, string> = {
  bash: `wt() {
  if [[ $1 == cd ]]; then shift; local p; p=$(command wt path "$@") && cd "$p"
  else command wt "$@"; fi
}
_wt() {
  local words=$(command wt _complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)
  COMPREPLY=($(compgen -W "$words" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _wt wt
`,
  zsh: `wt() {
  if [[ $1 == cd ]]; then shift; local p; p=$(command wt path "$@") && cd "$p"
  else command wt "$@"; fi
}
_wt() {
  local -a w
  w=(\${(f)"$(command wt _complete \${words[2,CURRENT-1]} 2>/dev/null)"})
  compadd -a w
}
(( $+functions[compdef] )) && compdef _wt wt
`,
  fish: `function wt
  if test "$argv[1]" = cd
    set -l p (command wt path $argv[2..-1]); and cd $p
  else
    command wt $argv
  end
end
complete -c wt -f -a '(command wt _complete (commandline -opc)[2..-1] 2>/dev/null)'
`,
};

export const SHELLS = Object.keys(SNIPPETS);

export function cmdShellInit(shell = basename(process.env.SHELL ?? '')) {
  const s = SNIPPETS[shell] ?? die(`wt shell-init <${SHELLS.join('|')}>`);
  out(s);
  return 0;
}
