/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT "workspace" shell approval.
 *
 * Decides whether a shell command may run WITHOUT a confirmation prompt:
 *
 *   auto  – everything that stays inside the workspace and is not destructive
 *   ask   – deletes, git history/worktree rewrites, privilege escalation,
 *           anything that reads/writes a path outside the workspace, anything
 *           touching ~/.afot, pipe-to-interpreter, and anything we cannot parse
 *
 * LIMITS (read before trusting this):
 *   - It inspects the COMMAND TEXT only. `cargo test`, `npm test`, `python x.py`
 *     or `./run.sh` run whatever code is inside them, and that code can delete
 *     or move anything. Real containment needs an OS sandbox.
 *   - It fails closed: unparseable input, parser disagreement, command
 *     substitution, loops and unknown wrappers all ask.
 */

import os from 'node:os';
import path from 'node:path';
import {
  detectCommandSubstitution,
  getCommandRoots,
  getShellConfiguration,
  initializeShellParsers,
  parseCommandDetails,
  stripShellWrapper,
  type CommandParseResult,
} from '../utils/shell-utils.js';
import { resolveToRealPath } from '../utils/paths.js';

export type WorkspaceShellVerdict =
  | { auto: true }
  | { auto: false; reason: string };

export interface WorkspaceShellOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** Workspace roots. A path inside any of them counts as "inside". */
  workspaceDirs: readonly string[];
  /** Extra directories the user explicitly granted (path grants). */
  extraAllowedDirs?: readonly string[];
  /** The AFOT config directory (~/.afot). Always requires approval. */
  afotDir?: string;
  /** Target platform. Defaults to process.platform (tests override). */
  platform?: NodeJS.Platform;
  /** Shell syntax to assume. Defaults to the configured shell. */
  shellKind?: 'bash' | 'powershell' | 'cmd';
  /** Home directory for `~` expansion. Defaults to os.homedir(). */
  homeDir?: string;
  /** Parser override. Tests only: lets Linux CI emulate the PowerShell AST. */
  parser?: {
    parse: (command: string) => CommandParseResult | null;
    roots: (command: string) => string[];
  };
}

const MAX_DEPTH = 3;
const ASK = (reason: string): WorkspaceShellVerdict => ({
  auto: false,
  reason,
});

// ─── Command tables ───────────────────────────────────────────────────────────

const DELETE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'wipe',
  'trash',
  'trash-put',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
]);

const POWERSHELL_RISKY = new Set([
  'set-executionpolicy',
  'set-itemproperty',
  'new-itemproperty',
  'set-service',
  'new-service',
  'set-acl',
  'invoke-command',
  'enter-pssession',
  'new-pssession',
  'invoke-wmimethod',
  'invoke-cimmethod',
  'register-scheduledtask',
  'new-scheduledtask',
]);

const PRIVILEGE_COMMANDS = new Set([
  'sudo',
  'su',
  'doas',
  'runas',
  'pkexec',
  'gsudo',
]);

const SYSTEM_COMMANDS = new Set([
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'format',
  'diskpart',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'kill',
  'killall',
  'pkill',
  'taskkill',
  'stop-process',
  'systemctl',
  'service',
  'launchctl',
  'sc',
  'mount',
  'umount',
  'crontab',
  'reg',
  'setx',
  'schtasks',
  'eval',
  'exec',
]);

/** Commands that send data to / run commands on another machine. */
const REMOTE_COMMANDS = new Set([
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'socat',
]);

/** Commands that move/copy/create data: unresolved variables in args are unsafe. */
const MUTATOR_COMMANDS = new Set([
  'cp',
  'mv',
  'ln',
  'install',
  'tee',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'tar',
  'unzip',
  'zip',
  '7z',
  'rsync',
  'curl',
  'wget',
  'copy',
  'move',
  'xcopy',
  'robocopy',
  'copy-item',
  'move-item',
  'new-item',
  'set-content',
  'add-content',
  'out-file',
  'tee-object',
  'invoke-webrequest',
  'invoke-restmethod',
  'iwr',
  'irm',
  'ren',
  'rename',
  'rename-item',
  'mi',
  'ci',
  'cpi',
  'ni',
]);

/** Commands whose arguments are plain text, so "delete" etc. is just a search term. */
const TEXT_ARG_COMMANDS = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'sed',
  'diff',
  'jq',
  'yq',
  'write-output',
  'select-string',
  'sls',
  'findstr',
]);

const PATTERN_FIRST = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sed',
  'awk',
  'select-string',
  'sls',
  'findstr',
]);

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
]);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const INLINE_INTERPRETERS = new Set([
  'python',
  'python2',
  'python3',
  'py',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
]);
const STDIN_INTERPRETERS = new Set([
  ...SHELLS,
  ...POWERSHELLS,
  ...INLINE_INTERPRETERS,
  'iex',
  'invoke-expression',
]);

const PASS_THROUGH = new Set([
  'env',
  'time',
  'nohup',
  'nice',
  'ionice',
  'stdbuf',
  'command',
  'builtin',
  'timeout',
  'setsid',
  'caffeinate',
  'busybox',
  'toybox',
]);

/** Subcommand words that mean "delete / destroy" for infra-style CLIs. */
const DESTRUCTIVE_WORDS = new Set([
  'rm',
  'rmi',
  'delete',
  'destroy',
  'terminate',
  'purge',
  'drop',
  'remove',
  'prune',
  'uninstall',
  'unpublish',
  'publish',
  'push',
]);

/** CLIs where the destructive word can appear as the 2nd subcommand. */
const TWO_LEVEL_CLIS = new Set([
  'docker',
  'podman',
  'kubectl',
  'helm',
  'aws',
  'gcloud',
  'az',
  'gh',
  'terraform',
  'tofu',
]);

const INLINE_CODE_RISK =
  /(rmtree|os\.remove|os\.unlink|os\.rmdir|os\.rename|shutil\.(move|rmtree)|unlinkSync|rmSync|rmdirSync|fs\.(rm|unlink|rmdir|rename)|Remove-Item|\brm\s+-|\bdel\s+\/|child_process|subprocess|os\.system|\bexec\()/i;
const INLINE_PATH_RISK =
  /(^|[\s'"(=,])(\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\.\.[\\/]|\$HOME|%USERPROFILE%)/;

// ─── Tokenizer (no backslash-escape processing for Windows paths) ─────────────

interface Segment {
  tokens: string[];
  /** True when this segment is preceded by a pipe. */
  piped: boolean;
}

/**
 * Splits a command into simple-command segments on unquoted `&& || ; | & \n ( )`.
 * Quotes are removed, backslashes are only treated as escapes on POSIX and only
 * outside single quotes. Redirection operators stay attached to their tokens.
 * Returns null when quotes are unbalanced.
 */
export function tokenizeSegments(
  command: string,
  posixEscapes: boolean,
): Segment[] | null {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let cur = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;
  let curPiped = false;

  const endTok = () => {
    if (inTok) {
      tokens.push(cur);
      cur = '';
      inTok = false;
    }
  };
  const endSeg = (piped: boolean) => {
    endTok();
    if (tokens.length > 0) segments.push({ tokens, piped: curPiped });
    tokens = [];
    curPiped = piped;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (
        ch === '\\' &&
        quote === '"' &&
        posixEscapes &&
        i + 1 < command.length
      ) {
        cur += command[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inTok = true;
      continue;
    }
    if (ch === '\\' && posixEscapes && i + 1 < command.length) {
      cur += command[++i];
      inTok = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endTok();
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      endSeg(false);
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        i++;
        endSeg(false);
        continue;
      }
      // `&>file`, `>&2`, `2>&1` are redirections, not separators
      const prev = command[i - 1];
      if (command[i + 1] === '>' || prev === '>' || prev === '<') {
        cur += ch;
        inTok = true;
        continue;
      }
      endSeg(false);
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        i++;
        endSeg(false);
        continue;
      }
      if (command[i + 1] === '&') i++;
      endSeg(true);
      continue;
    }
    cur += ch;
    inTok = true;
  }
  if (quote) return null;
  endSeg(false);
  return segments;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseName(cmd: string): string {
  const b = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return b.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function isEnvAssignment(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

const HOME_VAR =
  /^(\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME|~)(?=$|[\\/])/i;

function expandHome(tok: string, home: string, lib: typeof path): string {
  const m = HOME_VAR.exec(tok);
  if (!m) return tok;
  return lib.join(home, tok.slice(m[0].length));
}

function hasVariable(tok: string): boolean {
  return /\$|%[A-Za-z_]+%|`/.test(tok);
}

const NULL_SINKS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  'nul',
  '$null',
]);

function looksLikePath(tok: string): boolean {
  if (!tok) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return false; // URL
  return (
    tok.startsWith('/') ||
    tok.startsWith('~') ||
    tok.startsWith('./') ||
    tok.startsWith('.\\') ||
    tok === '.' ||
    tok === '..' ||
    /(^|[\\/])\.\.([\\/]|$)/.test(tok) ||
    /^[A-Za-z]:[\\/]/.test(tok) ||
    HOME_VAR.test(tok) ||
    tok.includes('/') ||
    tok.includes('\\')
  );
}

class Ctx {
  readonly lib: typeof path;
  readonly win: boolean;
  readonly native: boolean;
  readonly home: string;
  readonly parse: (c: string) => CommandParseResult | null;
  readonly roots: (c: string) => string[];

  constructor(
    readonly opts: WorkspaceShellOptions,
    public cwd: string,
    readonly posix: boolean,
    platform: NodeJS.Platform,
  ) {
    this.win = platform === 'win32';
    this.lib = this.win ? path.win32 : path.posix;
    this.native = platform === process.platform;
    this.home = opts.homeDir ?? os.homedir();
    // Parse with the grammar of the shell under analysis, not the host's.
    const shellKind = posix ? 'bash' : 'powershell';
    this.parse =
      opts.parser?.parse ?? ((c) => parseCommandDetails(c, shellKind));
    this.roots = opts.parser?.roots ?? ((c) => getCommandRoots(c, shellKind));
  }

  private real(p: string): string {
    if (!this.native) return this.lib.resolve(p);
    try {
      return resolveToRealPath(p);
    } catch {
      return this.lib.resolve(p);
    }
  }

  private within(root: string, p: string): boolean {
    const norm = (x: string) => (this.win ? x.toLowerCase() : x);
    const rel = this.lib.relative(norm(root), norm(p));
    if (rel === '') return true;
    return (
      rel !== '..' &&
      !rel.startsWith('..' + this.lib.sep) &&
      !this.lib.isAbsolute(rel)
    );
  }

  private allowedRoots(): string[] {
    return [...this.opts.workspaceDirs, ...(this.opts.extraAllowedDirs ?? [])]
      .filter(Boolean)
      .map((d) => this.real(this.lib.resolve(d)));
  }

  resolve(tok: string): string {
    const expanded = expandHome(tok, this.home, this.lib);
    return this.lib.isAbsolute(expanded)
      ? this.lib.resolve(expanded)
      : this.lib.resolve(this.cwd, expanded);
  }

  /** Returns a reason string when `tok` is outside the allowed area, else null. */
  checkPath(tok: string): string | null {
    if (NULL_SINKS.has(tok.toLowerCase())) return null;
    if (tok.startsWith('~') && !HOME_VAR.test(tok)) {
      return `path outside the workspace: ${tok}`;
    }
    const expanded = expandHome(tok, this.home, this.lib);
    if (hasVariable(expanded) && !HOME_VAR.test(tok)) return null; // handled by mutator rule
    const real = this.real(this.resolve(tok));
    if (this.opts.afotDir) {
      const afot = this.real(this.lib.resolve(this.opts.afotDir));
      if (this.within(afot, real)) {
        return `touches the AFOT config directory (${tok})`;
      }
    }
    for (const root of this.allowedRoots()) {
      if (this.within(root, real)) return null;
    }
    return `path outside the workspace: ${tok}`;
  }
}

// ─── Per-command rules ────────────────────────────────────────────────────────

const GIT_GLOBAL_WITH_ARG = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

function gitVerdict(args: string[], ctx: Ctx): WorkspaceShellVerdict | null {
  // Skip global options, validating -C / --git-dir / --work-tree targets.
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    if (key === '-c') {
      return ASK('git -c can run arbitrary commands through config');
    }
    if (GIT_GLOBAL_WITH_ARG.has(key)) {
      const val = eq === -1 ? args[i + 1] : a.slice(eq + 1);
      if (key !== '-c' && val !== undefined) {
        const bad = ctx.checkPath(val);
        if (bad) return ASK(`git ${key}: ${bad}`);
      }
      i += eq === -1 ? 2 : 1;
    } else {
      i += 1;
    }
  }
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  const has = (...flags: string[]) =>
    rest.some((r) => flags.includes(r.toLowerCase()));
  if (!sub) return null;

  switch (sub) {
    case 'reset':
    case 'revert':
    case 'clean':
    case 'restore':
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
    case 'replace':
      return ASK(`git ${sub} rewrites or discards work`);
    case 'rm':
      return ASK('git rm deletes files');
    case 'push':
      return ASK('git push sends data off this machine');
    case 'commit':
      if (has('--amend')) return ASK('git commit --amend rewrites history');
      return null;
    case 'checkout':
      if (
        has(
          '--',
          '-f',
          '--force',
          '--ours',
          '--theirs',
          '-p',
          '--patch',
          '.',
          '-B',
        )
      ) {
        return ASK('git checkout can discard local changes');
      }
      return null;
    case 'switch':
      if (has('-f', '--force', '--discard-changes', '-C')) {
        return ASK('git switch can discard local changes');
      }
      return null;
    case 'stash': {
      const op = rest[0]?.toLowerCase();
      if (op === 'drop' || op === 'clear') {
        return ASK(`git stash ${op} discards stashed work`);
      }
      return null;
    }
    case 'branch':
      if (has('-d', '-D', '--delete', '-f', '--force', '-m', '-M', '--move')) {
        return ASK('git branch delete/rename/force');
      }
      return null;
    case 'tag':
      if (has('-d', '--delete', '-f', '--force')) {
        return ASK('git tag delete/force');
      }
      return null;
    case 'reflog':
    case 'gc':
    case 'prune':
      return ASK(`git ${sub} can permanently drop objects`);
    case 'bisect':
      if (rest[0]?.toLowerCase() === 'run')
        return ASK('git bisect run executes a command');
      return null;
    case 'worktree':
    case 'submodule':
    case 'remote':
      if (rest.includes('foreach'))
        return ASK('git submodule foreach executes commands');
      if (rest.some((r) => ['remove', 'prune', 'deinit', 'rm'].includes(r))) {
        return ASK(`git ${sub} removal`);
      }
      return null;
    case 'config':
      if (
        has('--global', '--system', '--unset', '--unset-all', '--edit', '-e')
      ) {
        return ASK('git config outside this repository');
      }
      return null;
    default:
      return null;
  }
}

/** CLIs whose first (or second) subcommand word can mean delete/publish. */
const SUBCOMMAND_CLIS = new Set([
  ...TWO_LEVEL_CLIS,
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'pip',
  'pip3',
  'gem',
  'composer',
  'twine',
  'poetry',
  'dotnet',
  'brew',
  'apt',
  'apt-get',
  'choco',
  'winget',
  'scoop',
]);

function destructiveSubcommand(name: string, args: string[]): string | null {
  if (!SUBCOMMAND_CLIS.has(name)) return null;
  const nonFlags = args.filter((a) => !a.startsWith('-'));
  const candidates = TWO_LEVEL_CLIS.has(name)
    ? nonFlags.slice(0, 2)
    : nonFlags.slice(0, 1);
  for (const c of candidates) {
    if (DESTRUCTIVE_WORDS.has(c.toLowerCase())) {
      return `${name} ${c} is destructive or publishes`;
    }
  }
  return null;
}

function globalInstall(name: string, args: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase());
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    if (
      lower.includes('-g') ||
      lower.includes('--global') ||
      lower[0] === 'global'
    ) {
      return `${name} global install/remove`;
    }
  }
  if (name === 'cargo' && lower[0] === 'install')
    return 'cargo install is global';
  if (['pip', 'pip3'].includes(name) && lower.includes('--user')) {
    return 'pip --user install is outside the workspace';
  }
  return null;
}

// ─── Core classification ──────────────────────────────────────────────────────

function classifySegment(
  segTokens: string[],
  piped: boolean,
  isFirstInPipeline: boolean,
  ctx: Ctx,
  depth: number,
  viaXargs = false,
): WorkspaceShellVerdict {
  const toks = [...segTokens];

  // Peel env assignments and pass-through wrappers.
  for (let guard = 0; guard < 8; guard++) {
    while (toks.length > 0 && isEnvAssignment(toks[0])) toks.shift();
    if (toks.length === 0) return { auto: true };
    const head = baseName(toks[0]);
    if (PASS_THROUGH.has(head)) {
      toks.shift();
      if (head === 'timeout') {
        while (toks.length > 0 && toks[0].startsWith('-')) toks.shift();
        toks.shift(); // duration
      } else if (head === 'nice' || head === 'ionice') {
        while (toks.length > 0 && toks[0].startsWith('-')) {
          const f = toks.shift()!;
          if (f === '-n' || f === '-c') toks.shift();
        }
      } else if (head === 'env') {
        while (
          toks.length > 0 &&
          (toks[0].startsWith('-') || isEnvAssignment(toks[0]))
        ) {
          if (toks[0].startsWith('-') && toks[0] !== '-i') {
            // -u NAME / -C DIR / -S STR take arguments: refuse to guess
            if (
              ['-u', '-C', '-S', '--chdir', '--split-string'].includes(toks[0])
            ) {
              return ASK(
                'env option that changes directory or splits a string',
              );
            }
          }
          toks.shift();
        }
      } else {
        while (toks.length > 0 && toks[0].startsWith('-')) toks.shift();
      }
      continue;
    }
    break;
  }
  if (toks.length === 0) return { auto: true };

  // Redirection operators: collect targets, drop them from the argv.
  const argv: string[] = [];
  const redirTargets: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = /^(\d*|&)?(>>|>\||>&|>|<<<|<<|<&|<)(.*)$/.exec(t);
    if (m && !(i === 0)) {
      const op = m[2];
      let target = m[3] ?? '';
      if (op === '<<' || op === '<<<') {
        if (!target) i++; // heredoc delimiter / herestring word is data
        continue;
      }
      if (!target) target = toks[++i] ?? '';
      if (/^\d+$/.test(target) || target === '-') continue; // fd duplication
      redirTargets.push(target);
      continue;
    }
    argv.push(t);
  }
  if (argv.length === 0) return { auto: true };

  const name = baseName(argv[0]);
  const args = argv.slice(1);
  if (/[{}$*?[\]`~%]/.test(argv[0])) {
    return ASK(`command name is dynamic: ${argv[0]}`);
  }

  for (const t of redirTargets) {
    if (hasVariable(t) && !HOME_VAR.test(t)) {
      return ASK(`redirect target uses an unresolved variable: ${t}`);
    }
    const bad = ctx.checkPath(t);
    if (bad) return ASK(`redirect: ${bad}`);
  }

  if (DELETE_COMMANDS.has(name)) return ASK(`${name} deletes files`);
  if (
    /^(remove|clear|stop|restart|unregister|uninstall|disable|revoke)-/.test(
      name,
    ) ||
    POWERSHELL_RISKY.has(name) ||
    (name === 'start-process' && args.some((a) => a.toLowerCase() === 'runas'))
  ) {
    return ASK(`${name} removes or changes system state`);
  }
  if (PRIVILEGE_COMMANDS.has(name)) return ASK(`${name} escalates privileges`);
  if (SYSTEM_COMMANDS.has(name)) return ASK(`${name} changes system state`);
  if (REMOTE_COMMANDS.has(name)) return ASK(`${name} talks to another machine`);
  if (name.startsWith('mkfs')) return ASK('mkfs formats a disk');

  if (name === 'xargs') {
    const rest = [...args];
    const withArg = new Set([
      '-n',
      '-p',
      '-i',
      '-l',
      '-s',
      '-d',
      '-e',
      '-a',
      '-p',
    ]);
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const f = rest.shift()!;
      if (/^-[nPILsdEa]$/.test(f) || withArg.has(f.toLowerCase())) rest.shift();
      else if (
        !/^(-0|-r|-t|--null|--no-run-if-empty|--verbose|-I\S*|-n\S+|-P\S+)$/.test(
          f,
        )
      ) {
        return ASK(`xargs option ${f} not understood`);
      }
    }
    if (rest.length === 0) return ASK('xargs without a command');
    return classifySegment(rest, false, false, ctx, depth, true);
  }

  if (
    name === 'cd' ||
    name === 'pushd' ||
    name === 'set-location' ||
    name === 'sl' ||
    name === 'chdir'
  ) {
    const target = args.find(
      (a) => !a.startsWith('-') && a.toLowerCase() !== '/d',
    );
    if (!target || target === '-' || target === '~') {
      return ASK(`${name} without a workspace path`);
    }
    if (hasVariable(target) && !HOME_VAR.test(target)) {
      return ASK(`${name} to an unresolved variable`);
    }
    const bad = ctx.checkPath(target);
    if (bad) return ASK(`${name}: ${bad}`);
    ctx.cwd = ctx.resolve(target);
    return { auto: true };
  }
  if (name === 'popd') return ASK('popd leaves the tracked directory');

  // Shell / interpreter wrappers
  if (SHELLS.has(name) || POWERSHELLS.has(name) || name === 'cmd') {
    if (/^-(e|enc|encodedcommand)$/i.test(args[0] ?? '')) {
      return ASK('encoded command');
    }
    if (name === 'cmd') return ASK('cmd /c is not analysed');
    const isPs = POWERSHELLS.has(name);
    const flagIdx = args.findIndex((a) =>
      isPs ? /^-(c|command)$/i.test(a) : /^-[a-zA-Z]*c$/.test(a),
    );
    if (flagIdx !== -1) {
      const inner = isPs
        ? args.slice(flagIdx + 1).join(' ')
        : args[flagIdx + 1];
      if (!inner) return ASK('shell -c without a command');
      if (depth >= MAX_DEPTH) return ASK('nested shells too deep');
      return classifyCommand(inner, ctx, depth + 1);
    }
    if (piped && !args.some((a) => !a.startsWith('-'))) {
      return ASK('pipe into a shell');
    }
  }
  if (
    piped &&
    STDIN_INTERPRETERS.has(name) &&
    !args.some((a) => !a.startsWith('-'))
  ) {
    return ASK(`pipe into ${name}`);
  }
  if (name === 'iex' || name === 'invoke-expression')
    return ASK('Invoke-Expression');

  if (INLINE_INTERPRETERS.has(name)) {
    const idx = args.findIndex((a) =>
      /^(-c|-e|-p|--eval|--command|-r|-E)$/i.test(a),
    );
    if (idx !== -1) {
      const code = args[idx + 1] ?? '';
      if (INLINE_CODE_RISK.test(code))
        return ASK('inline code deletes/moves/spawns');
      if (INLINE_PATH_RISK.test(code))
        return ASK('inline code references an outside path');
      args.splice(idx, 2); // code is data, not a path
    }
  }

  if (name === 'find') {
    if (args.some((a) => a === '-delete')) return ASK('find -delete');
    const execIdx = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    if (execIdx !== -1) {
      const inner: string[] = [];
      for (let k = execIdx + 1; k < args.length; k++) {
        if (args[k] === ';' || args[k] === '+') break;
        inner.push(args[k]);
      }
      if (inner.length === 0) return ASK('find -exec without a command');
      const v = classifySegment(
        inner.filter((t) => t !== '{}'),
        false,
        false,
        ctx,
        depth,
      );
      if (!v.auto) return v;
      args.splice(execIdx);
    }
  }

  if (name === 'git') {
    const v = gitVerdict(args, ctx);
    if (v) return v;
  }

  if (!TEXT_ARG_COMMANDS.has(name)) {
    const d = destructiveSubcommand(name, args);
    if (d) return ASK(d);
  }
  const g = globalInstall(name, args);
  if (g) return ASK(g);

  if (viaXargs && MUTATOR_COMMANDS.has(name)) {
    return ASK(`${name} fed by xargs has unknown paths`);
  }

  if (
    name === 'tar' &&
    args.some((a) =>
      /^(--to-command|--checkpoint-action|--use-compress-program|--rsh-command|-I)\b/.test(
        a,
      ),
    )
  ) {
    return ASK('tar option that runs a command');
  }
  if (name === 'sed' || name === 'awk') {
    const scripts: string[] = [];
    for (let k = 0; k < args.length; k++) {
      if (/^-(e|f)$/.test(args[k]) || args[k] === '--expression')
        scripts.push(args[++k] ?? '');
    }
    if (scripts.length === 0) {
      const first = args.find((a) => !a.startsWith('-'));
      if (first) scripts.push(first);
    }
    const risky =
      name === 'sed'
        ? /(^|[;{}\s])[ewEW]\s+\S|\/[gIpm0-9]*[ew]\b|s(.).*?\2.*?\2[gIpm0-9]*[ew]/
        : /system\s*\(|getline|print[^;}]*[>|]|printf[^;}]*[>|]/;
    if (scripts.some((sc) => risky.test(sc))) {
      return ASK(`${name} script can run commands or write files`);
    }
    if (args.some((a) => a === '-f' || a === '--file')) {
      return ASK(`${name} script file is not analysed`);
    }
  }

  // echo/printf arguments are text; grep-like tools take a pattern first.
  if (name === 'echo' || name === 'printf' || name === 'write-output') {
    return { auto: true };
  }
  if (PATTERN_FIRST.has(name)) {
    const idx = args.findIndex((a) => !a.startsWith('-'));
    if (idx !== -1) args.splice(idx, 1);
  }

  // Path arguments
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    let candidate: string | null = null;

    if (a.startsWith('--') && a.includes('=')) {
      candidate = a.slice(a.indexOf('=') + 1);
    } else if (a.startsWith('-') && a.length > 2 && /[\\/~]/.test(a)) {
      candidate = a.replace(/^-+[A-Za-z]/, '');
    } else if (a.startsWith('-')) {
      continue;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      candidate = a.slice(a.indexOf('=') + 1); // dd of=/path, KEY=value
    } else {
      candidate = a;
    }
    if (!candidate) continue;
    if (candidate.startsWith('@')) candidate = candidate.slice(1); // curl -d @file
    if (candidate.startsWith('file://')) {
      try {
        candidate = new URL(candidate).pathname;
      } catch {
        return ASK(`unreadable file URL: ${a}`);
      }
    }

    if (
      /\{[^}]*(,|\.\.)[^}]*\}/.test(candidate) &&
      (MUTATOR_COMMANDS.has(name) || /[\\/]/.test(candidate))
    ) {
      return ASK(`brace expansion in a path: ${a}`);
    }
    if (
      hasVariable(candidate) &&
      !HOME_VAR.test(candidate) &&
      /[\\/]/.test(candidate)
    ) {
      return ASK(`path built from a variable: ${a}`);
    }
    if (
      MUTATOR_COMMANDS.has(name) &&
      hasVariable(candidate) &&
      !HOME_VAR.test(candidate)
    ) {
      return ASK(`${name} with an unresolved variable in an argument: ${a}`);
    }
    if (!looksLikePath(candidate)) continue;
    const bad = ctx.checkPath(candidate);
    if (bad) return ASK(`${name}: ${bad}`);
  }

  void isFirstInPipeline;
  return { auto: true };
}

function classifyCommand(
  command: string,
  ctx: Ctx,
  depth: number,
): WorkspaceShellVerdict {
  const cmd = stripShellWrapper(command).trim();
  if (!cmd) return { auto: true };

  const parsed = ctx.parse(cmd);
  if (!parsed || parsed.hasError || parsed.details.length === 0) {
    return ASK('command could not be parsed');
  }
  if (
    parsed.hasCommandSubstitution ||
    detectCommandSubstitution(cmd, ctx.posix ? 'bash' : 'powershell')
  ) {
    return ASK('command substitution');
  }
  if (/<\(|>\(/.test(cmd)) return ASK('process substitution');
  if (/::\s*(Delete|Move|Replace)\s*\(|\.Delete\s*\(/i.test(cmd)) {
    return ASK('.NET file delete/move');
  }

  const segments = tokenizeSegments(cmd, ctx.posix);
  if (!segments) return ASK('unbalanced quotes');

  // Parser-differential guard: both parsers must see the same command names.
  // Env assignments are prefixes, not commands. Some host parsers (PowerShell)
  // report `FOO=bar` as the command name; the real command is its first
  // non-assignment argument, so resolve it there instead of failing closed.
  const treeNames = ctx
    .roots(cmd)
    .map((name) => {
      if (!isEnvAssignment(name)) return baseName(name);
      const detail = parsed.details.find((d) => d.name === name);
      const next = detail?.args?.find((a) => !isEnvAssignment(a));
      return next ? baseName(next) : '';
    })
    .filter((n) => n.length > 0)
    .sort();
  const ownNames = segments
    .map((s) => {
      const t = [...s.tokens];
      while (t.length > 0 && isEnvAssignment(t[0])) t.shift();
      return t[0] ? baseName(t[0]) : '';
    })
    .filter(Boolean)
    .sort();
  if (
    treeNames.length !== ownNames.length ||
    treeNames.some((n, i) => n !== ownNames[i])
  ) {
    return ASK('command structure is ambiguous (loops, groups or odd quoting)');
  }

  for (const seg of segments) {
    const v = classifySegment(seg.tokens, seg.piped, !seg.piped, ctx, depth);
    if (!v.auto) return v;
  }
  return { auto: true };
}

/**
 * Classifies a shell command for workspace auto-approval.
 * Never throws: any internal error becomes an "ask".
 */
export async function classifyWorkspaceShell(
  command: string,
  opts: WorkspaceShellOptions,
): Promise<WorkspaceShellVerdict> {
  try {
    await initializeShellParsers();
    const platform = opts.platform ?? process.platform;
    const shellKind =
      opts.shellKind ??
      (opts.parser ? 'powershell' : getShellConfiguration().shell);
    if (shellKind === 'cmd') return ASK('cmd.exe syntax is not analysed');
    const ctx = new Ctx(
      opts,
      path.resolve(opts.cwd),
      shellKind === 'bash',
      platform,
    );
    ctx.cwd = ctx.lib.resolve(opts.cwd);
    const insideStart = ctx.checkPath(ctx.cwd);
    if (insideStart) return ASK(`working directory: ${insideStart}`);
    return classifyCommand(command, ctx, 0);
  } catch (err) {
    return ASK(
      `classifier error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
