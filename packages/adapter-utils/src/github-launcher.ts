import path from "node:path";
import { ghCommandMayWrite, parseGhCommand } from "@paperclipai/shared";

/** The system directories a git that holds a GitHub credential may come from, in the order they are searched. */
const DEFAULT_TRUSTED_DIRS: readonly string[] = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"];

export interface GithubLauncherOptions {
  /** Directories (absolute) where the git that holds a credential is looked for; never the caller's PATH. Defaults to the system ones: /usr/bin, /usr/local/bin, /opt/homebrew/bin, /bin. */
  trustedDirs?: readonly string[];
  /** Require that this user cannot change the git it picks or the directories above it. On by default; a test turns it off to place a stand-in git. */
  requireProtectedDirs?: boolean;
}

/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: GithubLauncherOptions = {}): string {
  const trustedDirs = options.trustedDirs ?? DEFAULT_TRUSTED_DIRS;
  const requireProtectedDirs = options.requireProtectedDirs ?? true;
  const relative = trustedDirs.find((dir) => !path.isAbsolute(dir));
  if (relative !== undefined || trustedDirs.length === 0) throw new Error("The launcher's trusted directories must be absolute paths, and there must be one.");
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
// The same source also runs as git's SSH signing program (gpg.ssh.program).
const SIGNER = 'paperclip-ssh-sign';
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const findExecutable = name => originalPath.map(p => path.join(p, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
const executable = findExecutable(program === SIGNER ? 'ssh-keygen' : program);
if (!['git', 'gh', SIGNER].includes(program) || (!executable && program !== SIGNER)) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
// The git that holds a GitHub credential is never one found through the caller's PATH: whoever sets PATH (the agent) would be
// handed the credential by a program named git. It is the first git in the trusted directories (fixed system ones) that this user
// cannot change: the file and every directory above it belong to someone else and are not writable by this user (a symlink is
// followed, and what it points at must hold too). Its children get those directories as their PATH and nothing else. Root can
// change anything, so for root no check is possible and only the fixed directories count.
const TRUSTED_DIRS = ${JSON.stringify(trustedDirs)};
const REQUIRE_PROTECTED = ${JSON.stringify(requireProtectedDirs)};
const TRUSTED_PATH = TRUSTED_DIRS.join(path.delimiter);
// Why this user could change what is at file or above it (it owns it, or may write to it), or null.
function userCanChange(file) {
  if (!REQUIRE_PROTECTED) return null;
  if (typeof process.getuid !== 'function') return 'this platform cannot tell who may change files';
  const uid = process.getuid();
  if (uid === 0) return null;
  for (let at = file; ; at = path.dirname(at)) {
    let stat;
    try { stat = fs.statSync(at); } catch { return at + ' cannot be read'; }
    if (stat.uid === uid) return at + ' belongs to this user';
    try { fs.accessSync(at, fs.constants.W_OK); return at + ' is writable by this user'; } catch {}
    if (at === path.dirname(at)) return null;
  }
}
let trustedGitChoice;
function trustedGit() {
  if (trustedGitChoice) return trustedGitChoice;
  const rejected = [];
  for (const dir of TRUSTED_DIRS) {
    const candidate = path.join(dir, 'git');
    let real;
    try {
      real = fs.realpathSync(candidate);
      fs.accessSync(real, fs.constants.X_OK);
      if (!fs.statSync(real).isFile()) continue;
    } catch { continue; }
    const why = userCanChange(path.dirname(candidate)) || userCanChange(real);
    if (!why) return (trustedGitChoice = { path: real });
    rejected.push(why);
  }
  const where = TRUSTED_DIRS.join(', ');
  return (trustedGitChoice = { problem: rejected.length ? 'no git that this user cannot change was found in ' + where + ' (' + rejected.join('; ') + ')' : 'no git was found in ' + where });
}
const argv = process.argv.slice(2);
// The broker picks the identity (the company's GitHub App or a user) from the
// command and its repository. The command is sent, never stored or logged.
const GIT_GLOBAL_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'];
const GIT_REMOTE_COMMANDS = ['push', 'fetch', 'pull', 'ls-remote', 'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'];
// Options of git's network commands that take a value: long ones (next argument
// or --name=value) and short letters (attached, or the next argument, also at
// the end of a cluster such as -fo). The broker reads the same tables and
// refuses any option they do not list, so a value is never taken for the remote.
const GIT_FETCH_WITH_VALUE = ['--upload-pack', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--jobs', '--refmap', '--server-option',
  '--negotiation-tip', '--filter', '--recurse-submodules-default', '--submodule-prefix'];
const GIT_NETWORK_WITH_VALUE = {
  push: ['--repo', '--push-option', '--receive-pack', '--exec', '--recurse-submodules'],
  fetch: GIT_FETCH_WITH_VALUE,
  pull: [...GIT_FETCH_WITH_VALUE, '--strategy', '--strategy-option', '--cleanup'],
  clone: ['--origin', '--branch', '--upload-pack', '--reference', '--reference-if-able', '--separate-git-dir', '--depth', '--shallow-since', '--shallow-exclude',
    '--config', '--jobs', '--template', '--filter', '--server-option', '--bundle-uri', '--ref-format', '--revision'],
  'ls-remote': ['--upload-pack', '--server-option', '--sort'],
};
const GIT_SHORT_WITH_VALUE = { push: 'o', fetch: 'jo', pull: 'josX', clone: 'obucj', 'ls-remote': 'o' };
const GIT_SHORT_OPTIONAL = { pull: 'S' };
// Positional arguments of a git network command, push's --repo, and whether it deletes.
function gitNetworkArgs(subcommand, args) {
  const withValue = GIT_NETWORK_WITH_VALUE[subcommand] || [];
  const shortValue = GIT_SHORT_WITH_VALUE[subcommand] || '', shortOptional = GIT_SHORT_OPTIONAL[subcommand] || '';
  const positional = [];
  let repoOption = null, deleting = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--') { positional.push(...args.slice(at + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }
    if (arg.startsWith('--')) {
      if (subcommand === 'push' && arg === '--repo') { repoOption = args[at + 1] || null; at++; continue; }
      if (subcommand === 'push' && arg.startsWith('--repo=')) { repoOption = arg.slice(7); continue; }
      if (arg === '--delete') deleting = true;
      if (withValue.includes(arg)) at++;
      continue;
    }
    for (let i = 1; i < arg.length; i++) {
      if (shortValue.includes(arg[i])) { if (i + 1 >= arg.length) at++; break; }
      if (shortOptional.includes(arg[i])) break;
      if (subcommand === 'push' && arg[i] === 'd') deleting = true;
    }
  }
  return { positional, repoOption, deleting };
}
const gitBinary = () => program === 'git' ? executable : findExecutable('git');
// status is null when git could not run, timed out or wrote more than 4 MiB. An input is written to git's standard input.
function gitRun(env, globalArgs, args, input) {
  const git = gitBinary();
  if (!git) return { status: null, stdout: '' };
  try {
    const result = require('node:child_process').spawnSync(git, [...globalArgs, ...args],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], ...(input === undefined ? {} : { input }) });
    return { status: result.error ? null : result.status, stdout: result.stdout || '' };
  } catch { return { status: null, stdout: '' }; }
}
function appendGitConfig(env, key, value) {
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  env['GIT_CONFIG_KEY_' + count] = key; env['GIT_CONFIG_VALUE_' + count] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}
function gitOutput(env, globalArgs, args, input) {
  const result = gitRun(env, globalArgs, args, input);
  return result.status === 0 ? result.stdout : null;
}
// A configured remote name (git looks remote names up before treating an argument as a path).
const REMOTE_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9_.\/-]{1,100}$/;
// Fetches use the remote's (first) URL; pushes use its push URL.
function remoteUrl(env, globalArgs, name, push = true) {
  if (!REMOTE_NAME.test(name)) return null;
  const url = gitOutput(env, globalArgs, ['remote', 'get-url', ...(push ? ['--push'] : []), name]);
  return url ? url.trim().slice(0, 1000) || null : null;
}
// '' when the key is unset, null when git could not tell (an unreadable config counts as set).
function gitConfigValue(env, globalArgs, key, type) {
  const result = gitRun(env, globalArgs, ['config', ...(type ? ['--type=' + type] : []), '--get', key]);
  return result.status === 0 ? result.stdout.trim() : result.status === 1 ? '' : null;
}
// The first positional argument of a git network command: its repository (remote name, URL or path).
function gitNetworkTarget(subcommand, args) {
  return gitNetworkArgs(subcommand, args).positional[0];
}
// The launcher's own rewrites only map SSH spellings of github.com to HTTPS.
const OWN_REWRITES = ['git@github.com:', 'ssh://git@github.com/', 'git@www.github.com:', 'ssh://git@www.github.com/'];
function foreignRewrites(env, globalArgs) {
  const result = gitRun(env, globalArgs, ['config', '--get-regexp', '^url\\..*\\.(push)?insteadof$']);
  // No rewrite configured; any other failure (unreadable or oversized config) counts as a rewrite.
  if (result.status === 1) return false;
  if (result.status !== 0) return true;
  const lines = result.stdout.split('\n').filter(Boolean);
  return lines.some(line => {
    const match = /^url\.(.*)\.(?:push)?insteadof (.*)$/i.exec(line);
    return !match || match[1] !== 'https://github.com/' || !OWN_REWRITES.includes(match[2]);
  });
}
// Workflow files in a push. For a push of one commit that changes them the broker is told what it needs to check
// that history: every workflow file at the pushed commit, each new commit that changes workflow files (with its
// parents and those files), and the parents where new history joins commits that already exist. More than the
// broker reads, or anything git cannot tell, is not reported (the report stays readable and the toggle decides).
const WORKFLOWS = '.github/workflows';
const MAX_WORKFLOW_FILES = 100, MAX_WORKFLOW_COMMITS = 100, MAX_WORKFLOW_ENTRIES = 8, MAX_WORKFLOW_CHANGES = 400, MAX_WORKFLOW_PARENTS = 16, MAX_WORKFLOW_PATH = 300;
const isWorkflowPath = file => file === WORKFLOWS || file.startsWith(WORKFLOWS + '/');
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Every file under .github/workflows at a commit, by path (mode and blob); null when git could not tell.
function workflowTree(env, globalArgs, commit) {
  const listing = gitOutput(env, globalArgs, ['ls-tree', '-z', '-r', '--full-tree', commit, '--', WORKFLOWS]);
  if (listing === null) return null;
  const files = new Map();
  for (const entry of listing.split('\0')) {
    const parsed = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (parsed) files.set(parsed[3], { mode: parsed[1], oid: parsed[2] });
  }
  return files;
}
// The workflow paths a commit changes against its first parent, as the commit has them (mode and blob; null when
// gone). Renames are not paired, so a moved workflow shows its old name as gone. Null when git could not tell.
function workflowChangesOf(env, globalArgs, commit, parent) {
  const raw = gitOutput(env, globalArgs, ['diff-tree', '-z', '-r', '--no-renames', '--raw', '--abbrev=64', '--no-commit-id', ...(parent ? [parent, commit] : ['--root', commit]), '--', ':(top)' + WORKFLOWS]);
  if (raw === null) return null;
  const tokens = raw.split('\0'), changes = [];
  for (let at = 0; at < tokens.length; at++) {
    if (!tokens[at].startsWith(':')) continue;
    const [, mode, , oid, status] = tokens[at].slice(1).split(' ');
    const gone = status === 'D' || /^0+$/.test(mode);
    changes.push({ path: tokens[at + 1], mode: gone ? null : mode, oid: gone ? null : oid });
    at += 1;
  }
  return changes.sort((a, b) => byText(a.path, b.path));
}
// The branch a push of one commit updates, when its refspec spells it plainly; null for tags, patterns and the rest.
function pushedBranch(specs, current, refs) {
  if (specs.length > 1) return null;
  let name = current;
  if (specs.length) {
    const spec = specs[0], colon = spec.indexOf(':');
    name = colon < 0 ? spec : spec.slice(colon + 1);
    if (name === 'HEAD' || name === '@') name = current;
    else if (refs[name]) name = refs[name].startsWith('refs/heads/') ? refs[name].slice(11) : '';
    else if (name.startsWith('refs/heads/')) name = name.slice(11);
    else if (name.startsWith('heads/')) name = name.slice(6);
    else if (name.startsWith('refs/') || /[*?[]/.test(name)) name = '';
  }
  return name && !name.includes('..') && !/[\x00-\x20\x7f~^:\\]/.test(name) ? name : null;
}
// The pushed commit's workflow files, the new commits that change them and where new history joins old; null when too much to report.
// The boundary says what already exists: { args, input } for git's revision options (see pushReport).
function workflowHistory(env, globalArgs, tip, tipFiles, boundary) {
  const files = [...tipFiles].map(([file, entry]) => ({ path: file, ...entry })).sort((a, b) => byText(a.path, b.path));
  if (files.length > MAX_WORKFLOW_FILES || files.some(file => file.path.length > MAX_WORKFLOW_PATH)) return null;
  const listed = gitOutput(env, globalArgs, ['rev-list', '--parents', tip, ...boundary.args], boundary.input);
  if (listed === null) return null;
  const fresh = new Map();
  for (const line of listed.split('\n')) {
    const parts = line.split(' ').filter(Boolean);
    if (parts.length) fresh.set(parts[0], parts.slice(1));
  }
  if (fresh.size > MAX_WORKFLOW_COMMITS) return null;
  const commits = [], entries = new Set();
  let total = 0;
  for (const [sha, parents] of fresh) {
    if (parents.length > MAX_WORKFLOW_PARENTS) return null;
    for (const parent of parents) if (!fresh.has(parent)) entries.add(parent);
    const changes = workflowChangesOf(env, globalArgs, sha, parents[0]);
    if (changes === null) return null;
    if (!changes.length) continue;
    total += changes.length;
    if (changes.length > MAX_WORKFLOW_FILES || total > MAX_WORKFLOW_CHANGES || changes.some(change => change.path.length > MAX_WORKFLOW_PATH)) return null;
    commits.push({ sha, parents, changes });
  }
  // Nothing new: the pushed commit is where the push joins what exists.
  if (!fresh.size) entries.add(tip);
  if (entries.size > MAX_WORKFLOW_ENTRIES) return null;
  return { workflowFiles: files, workflowCommits: commits, workflowEntries: [...entries].sort() };
}
function sameWorkflowFiles(a, b) {
  return a.size === b.size && [...a].every(([file, entry]) => b.get(file) && b.get(file).mode === entry.mode && b.get(file).oid === entry.oid);
}
// What a push sends: the checked-out branch, full names of bare refspec names,
// the commits, and whether the push changes workflow files. What already exists is, at first, whatever the remote-tracking
// refs of this checkout say, and those refs are the agent's to write. Once the refs GitHub lists have been read (see
// remoteRefs), they replace them: known is { tips, heads }, or 'unknown' when they could not be read, and then nothing
// is reported as free of workflow changes.
// The remote a push goes to, as git reads the configuration: the argument, --repo, then branch and repository config.
// target is a remote name, a URL or a path; configured lists the URLs behind a configured remote name (git looks names
// up first); allUrls is where it goes.
function pushTarget(env, globalArgs, positional, repoOption, current, config) {
  const target = positional[0] || repoOption
    || (current && config('branch.' + current + '.pushRemote'))
    || config('remote.pushDefault')
    || (current && config('branch.' + current + '.remote'))
    || 'origin';
  // A configured remote name first (as git does); otherwise the target is itself a URL or path.
  const configured = !target.includes(':') && REMOTE_NAME.test(target)
    ? (gitOutput(env, globalArgs, ['remote', 'get-url', '--push', '--all', target]) || '').split('\n').map(url => url.trim()).filter(Boolean) : [];
  const allUrls = configured.length ? configured : /[:/]/.test(target) ? [target.slice(0, 1000)] : [];
  return { target, configured, allUrls };
}
function pushReport(env, globalArgs, pushArgs, known) {
  const { positional, repoOption, deleting } = gitNetworkArgs('push', pushArgs);
  const branch = gitOutput(env, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = branch ? branch.trim() : '';
  let unknown = false;
  const config = (key, type) => { const value = gitConfigValue(env, globalArgs, key, type); if (value === null) unknown = true; return value || ''; };
  // Booleans as git reads them (yes, on, 1 and true are all true); an invalid one is unknown, so it counts as set.
  const followTags = config('push.followTags', 'bool') === 'true';
  const { target, configured, allUrls } = pushTarget(env, globalArgs, positional, repoOption, current, config);
  const pushUrls = allUrls.slice(0, 16);
  // Without refspecs, repository config can make git push more than the current branch.
  const pushDefault = config('push.default');
  const implicitPush = positional.length <= 1 && (
    ['matching', 'upstream', 'tracking'].includes(pushDefault)
    || REMOTE_NAME.test(target) && (!!config('remote.' + target + '.push') || config('remote.' + target + '.mirror', 'bool') === 'true')
    || followTags || unknown);
  // Submodule recursion as git will read it for this push: the launcher forces "no", which only a -c or
  // --config-env on this command line can override.
  const forced = { ...env };
  appendGitConfig(forced, 'push.recurseSubmodules', 'no');
  const recursion = gitConfigValue(forced, globalArgs, 'push.recurseSubmodules');
  const specs = positional.slice(1).filter(spec => spec !== 'tag').map(spec => spec.replace(/^\+/, ''));
  const sources = deleting ? [] : specs.map(spec => spec.split(':')[0]).filter(Boolean);
  const refs = {};
  const names = [...new Set(specs.flatMap(spec => spec.split(':')).filter(name => name && !name.startsWith('refs/') && name !== 'HEAD' && name !== '@'))];
  for (const name of names.slice(0, 64)) {
    const full = (gitOutput(env, globalArgs, ['rev-parse', '--symbolic-full-name', name]) || '').trim();
    if (/^refs\/(heads|tags)\//.test(full)) refs[name] = full;
  }
  // More push URLs or ref names than reported: say so, so the broker refuses instead of checking part of it.
  const cut = allUrls.length > 16 || names.length > 64;
  const commits = sources.length ? sources : (specs.length || deleting ? [] : ['HEAD']);
  const shas = commits.map(source => (gitOutput(env, globalArgs, ['rev-parse', '--verify', '-q', source + '^{commit}']) || '').trim())
    .filter(sha => /^[0-9a-f]{40,64}$/.test(sha)).slice(0, 64);
  let touchesWorkflows = commits.length ? null : false;
  let workflow = null;
  // What already exists: the refs GitHub lists (stdin lines "^<sha>"), or else this checkout's remote-tracking refs.
  const boundary = known && known.tips
    ? { args: ['--stdin'], input: known.tips.map(tip => '^' + tip + '\n').join('') }
    : { args: ['--not', '--remotes'] };
  if (commits.length && shas.length === commits.length && known !== 'unknown') {
    // NUL-separated names (never quoted), merge commits' own changes against their first parent, and no rename pairing:
    // a workflow renamed or moved out of the directory shows as a deletion there.
    const files = gitOutput(env, globalArgs, ['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', ...shas, ...boundary.args], boundary.input);
    if (files !== null) {
      touchesWorkflows = files.split('\0').some(isWorkflowPath);
      // A commit that GitHub already has (on another branch, say) is not new, but a ref that is created or moved onto it is:
      // what the ref then holds is judged by its workflow files, not by which commits are new. The branch it replaces on
      // GitHub, or else GitHub's default branch, is what they are compared with (both as GitHub lists them, never as this
      // checkout's refs say). Anything that cannot be compared counts as a change.
      const defaultFiles = known && known.defaultTip ? workflowTree(env, globalArgs, known.defaultTip) : null;
      if (known && touchesWorkflows === false && shas.length > 1) {
        // Several refs at once cannot each be tied to a branch: every commit must carry the default branch's workflow files.
        touchesWorkflows = !defaultFiles || shas.some(sha => { const own = workflowTree(env, globalArgs, sha); return !own || !sameWorkflowFiles(own, defaultFiles); });
      }
      if (shas.length === 1) {
        const tipFiles = workflowTree(env, globalArgs, shas[0]);
        // A push that only moves a branch to a commit the remote already has (nothing is new) still changes the branch's
        // workflow files when they differ from the branch it replaces: as GitHub lists it, else as this checkout last saw it.
        const pushed = implicitPush ? null : pushedBranch(specs, current, refs);
        let seen = '', replaces = false;
        if (pushed && known) {
          const listed = known.heads.get(pushed) || '';
          replaces = !!listed;
          seen = listed ? (gitOutput(env, globalArgs, ['rev-parse', '--verify', '-q', listed + '^{commit}']) || '').trim() : '';
          // The branch GitHub has is a commit this checkout does not have, so what it holds cannot be compared: a replacement.
          if (listed && !seen && touchesWorkflows === false) touchesWorkflows = null;
        } else if (pushed && configured.length) {
          seen = (gitOutput(env, globalArgs, ['rev-parse', '--verify', '-q', 'refs/remotes/' + target + '/' + pushed + '^{commit}']) || '').trim();
        }
        const seenFiles = /^[0-9a-f]{40,64}$/.test(seen) ? workflowTree(env, globalArgs, seen) : null;
        if (tipFiles && seenFiles && !sameWorkflowFiles(tipFiles, seenFiles)) touchesWorkflows = true;
        // A new branch (or a push that cannot be tied to a branch GitHub has) must carry the default branch's workflow files.
        if (known && touchesWorkflows === false && !replaces) touchesWorkflows = !tipFiles || !defaultFiles || !sameWorkflowFiles(tipFiles, defaultFiles);
        if (touchesWorkflows && tipFiles) workflow = workflowHistory(env, globalArgs, shas[0], tipFiles, boundary);
      }
    }
  }
  return { currentBranch: current || null, refs, shas, touchesWorkflows, ...(workflow || {}), pushUrls, ...(implicitPush ? { implicitPush: true } : {}), ...(followTags || unknown ? { followTags: true } : {}),
    ...(recursion === 'no' || recursion === 'check' ? {} : { recurseSubmodules: recursion === null ? 'unknown' : recursion.slice(0, 100) }), ...(cut ? { truncated: true } : {}) };
}
// The branches and tags GitHub itself lists for a push's destination, read with the credential the broker just gave this
// command: { tips: the ones this checkout has, heads: branch name -> commit, defaultTip: the default branch's commit }.
// null when they cannot be read in full.
// This is what a push may call "already on GitHub"; the remote-tracking refs in a checkout say nothing of the sort.
// The read holds the credential, so it is a sealed command too (see privateGit): the literal URL, a git directory of its own
// and an environment of its own. What it lists is then checked against this checkout without the credential (local).
const MAX_REMOTE_REFS = 2000;
function remoteRefs(env, local, globalArgs, scratch, url) {
  const dir = privateGit(env, local, globalArgs, scratch, 'list');
  if (!dir) return null;
  const { spawnSync } = require('node:child_process');
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  try {
    lockPrivateGit(dir, false);
    // Branches, tags and HEAD (with the branch it names): the patterns keep the many refs/pull/* of a busy repository out of the list.
    const listed = spawnSync(dir.git, [...SEALED_CONFIG(dir), 'ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'],
      { ...options, env: { ...dir.sealed, GIT_NO_LAZY_FETCH: '1' }, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (listed.error || listed.status !== 0) return null;
    const lines = listed.stdout.split('\n').filter(Boolean);
    if (lines.length > MAX_REMOTE_REFS) return null;
    const shas = new Set(), heads = new Map();
    let defaultBranch = null;
    for (const line of lines) {
      const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
      if (symref) { defaultBranch = symref[1]; continue; }
      const match = /^([0-9a-f]{40,64})\t(?:HEAD|refs\/(heads|tags)\/(\S+?)(?:\^\{\})?)$/.exec(line);
      if (!match) return null;
      shas.add(match[1]);
      if (match[2] === 'heads') heads.set(match[3], match[1]);
    }
    // The default branch's commit, whether or not this checkout has it.
    const defaultTip = defaultBranch ? heads.get(defaultBranch) || '' : '';
    if (!shas.size) return { tips: [], heads, defaultTip };
    // Only objects this checkout has can be left out of what a push sends; git reads the others as missing.
    const present = spawnSync(dir.git, [...globalArgs, 'cat-file', '--batch-check'], { ...options, env: { ...local, GIT_NO_LAZY_FETCH: '1' }, timeout: 10000, input: [...shas].join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'] });
    if (present.error || present.status !== 0) return null;
    const tips = present.stdout.split('\n').map(line => line.split(' ')).filter(parts => parts[1] === 'commit' || parts[1] === 'tag').map(parts => parts[0]);
    return { tips, heads, defaultTip };
  } catch { return null; }
}
// A push that runs with a credential goes to one URL and sends one list of refs, both fixed before it starts. The URL is
// the literal target and every ref is <object>:<full name>, so nothing the child resolves comes from config or refs that a
// process of the agent's could change. It runs in a git directory of its own (nothing but the checkout's objects as an
// alternate, its shallow boundary, and a config that this launcher wrote and then made read-only), without hooks.
// What the checkout's config, hooks, remote names, refspecs and environment say after the check cannot reach it. A push
// that cannot be reduced to that is refused.
const PUSH_SHORT = { f: '--force', n: '--dry-run', q: '--quiet', v: '--verbose', 4: '--ipv4', 6: '--ipv6' };
const PUSH_LONG = ['--force', '--dry-run', '--quiet', '--verbose', '--progress', '--no-progress', '--porcelain', '--atomic', '--no-atomic', '--thin', '--no-thin',
  '--force-if-includes', '--no-force-if-includes', '--ipv4', '--ipv6', '--no-force-with-lease'];
// The sealed push does these itself, whatever was asked.
const PUSH_FORCED = ['--no-verify', '--verify', '--no-follow-tags', '--no-recurse-submodules'];
// The options a sealed push forwards, its arguments, and the ones it turns into something explicit: --delete and -d become
// deletions in the refspecs, -u is done after the push, and --force-with-lease becomes an expected value per ref. A problem
// names what cannot be reduced (--all, --mirror, --tags, --follow-tags, --prune, --signed, --receive-pack and any option
// not listed).
function sealedOptions(pushArgs) {
  const flags = [], rest = [], leases = [];
  let upstream = false, deleting = false, dryRun = false;
  const missing = { problem: 'an option is missing its value' };
  for (let at = 0; at < pushArgs.length; at++) {
    const arg = pushArgs[at];
    if (arg === '--') { rest.push(...pushArgs.slice(at + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { rest.push(arg); continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals), attached = equals < 0 ? undefined : arg.slice(equals + 1);
      if (PUSH_FORCED.includes(name) && attached === undefined) continue;
      if (name === '--recurse-submodules' && attached === 'no') continue;
      // The destination is bound by the sealed push, not by the option.
      if (name === '--repo') { if (attached === undefined) at++; continue; }
      if (name === '--push-option') {
        const value = attached === undefined ? pushArgs[++at] : attached;
        if (value === undefined) return missing;
        flags.push('--push-option=' + value);
        continue;
      }
      if (name === '--force-with-lease') { leases.push(attached); continue; }
      if (name === '--delete' && attached === undefined) { deleting = true; continue; }
      if (name === '--set-upstream' && attached === undefined) { upstream = true; continue; }
      if (PUSH_LONG.includes(name) && attached === undefined) {
        flags.push(arg);
        if (name === '--dry-run') dryRun = true;
        continue;
      }
      return { problem: 'the option ' + name.slice(0, 40) + ' sends refs that cannot be listed' };
    }
    for (let i = 1; i < arg.length; i++) {
      if (arg[i] === 'o') {
        const value = i + 1 < arg.length ? arg.slice(i + 1) : pushArgs[++at];
        if (value === undefined) return missing;
        flags.push('--push-option=' + value);
        break;
      }
      if (arg[i] === 'd') { deleting = true; continue; }
      if (arg[i] === 'u') { upstream = true; continue; }
      if (!PUSH_SHORT[arg[i]]) return { problem: 'the option -' + arg[i] + ' sends refs that cannot be listed' };
      flags.push(PUSH_SHORT[arg[i]]);
      if (arg[i] === 'n') dryRun = true;
    }
  }
  return { flags, rest, leases, upstream, deleting, dryRun };
}
// A sealed push's whole environment: nothing of the checkout's own steering (GIT_DIR, GIT_EXEC_PATH, GIT_TRACE*, GIT_SSH,
// object and index paths…) is carried over, only what a credentialed command needs.
const SEALED_ENV = /^(LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|SYSTEMROOT|COMSPEC|GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GH_HOST|GH_CONFIG_DIR|GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_SSH_COMMAND|SSH_AUTH_SOCK)$/;
// ssh never uses an agent, a config file or a key of the host: GitHub traffic is HTTPS, and an ssh URL is not a way around that.
const SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
function sealedEnv(env, home, gitDir) {
  const sealed = {};
  for (const [key, value] of Object.entries(env)) if (SEALED_ENV.test(key) && typeof value === 'string') sealed[key] = value;
  return { ...sealed, PATH: TRUSTED_PATH, HOME: home, GIT_DIR: gitDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_SSH_COMMAND: SSH_COMMAND };
}
// Every command that holds the credential runs in a git directory of the launcher's own (see privateGit), not in the checkout:
// the checkout's config can redirect it (url.*.insteadOf, http.<url>.proxy, remote URLs and their upload-pack), its hooks and
// helpers would run with the credential, and the agent's UID can change both after the broker has answered. Command-line
// config cannot undo that (a rewrite or a URL-scoped setting in the repository's own config ties with or outranks it), so
// the only thing that closes it is that the command never reads the checkout's config.
const SEALED_CONFIG = dir => ['-c', 'core.hooksPath=' + dir.hooks, '-c', 'protocol.ext.allow=never'];
// The git directory: no remotes, refs, hooks or settings of the checkout, a default config that this launcher wrote, and what
// the caller adds. Its setup runs without the credential (local is the checkout's environment as it was before any credential
// came); sealed is the environment of the one command that holds it. null when it cannot be made.
function privateGit(env, local, globalArgs, scratch, label) {
  const git = trustedGit().path;
  if (!git || !scratch) return null;
  const { spawnSync } = require('node:child_process');
  try {
    const root = fs.mkdtempSync(path.join(scratch, label + '-'));
    const gitDir = path.join(root, 'git'), hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    const setup = sealedEnv(local, root, gitDir);
    const format = (gitOutput(local, globalArgs, ['rev-parse', '--show-object-format']) || 'sha1').trim();
    const made = /^sha(1|256)$/.test(format)
      && spawnSync(git, ['init', '-q', '--bare', '--template=', '--object-format=' + format], { env: setup, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'] }).status === 0;
    return made ? { git, root, gitDir, hooks, setup, sealed: sealedEnv(env, root, gitDir) } : null;
  } catch { return null; }
}
// Read-only from here (the whole directory unless the command writes in it). A process of the same user can undo that, so it
// narrows the window and does not close it: what matters is that the destination, the refs and the settings are in the
// arguments and the environment, and that the config holds nothing of them.
function lockPrivateGit(dir, writable) {
  fs.chmodSync(path.join(dir.gitDir, 'config'), 0o400);
  fs.chmodSync(dir.gitDir, writable ? 0o700 : 0o500);
  // The (empty) directory that core.hooksPath names is locked too: a hook put there would run with the credential.
  fs.chmodSync(dir.hooks, 0o500);
  process.prependOnceListener('exit', () => { try { fs.chmodSync(dir.gitDir, 0o700); fs.chmodSync(dir.hooks, 0o700); } catch {} });
}
// A ref as the child is given it: whole, with no characters that git refuses or that could be taken for something else.
const WHOLE_REF = /^refs\/[^\s~^:?*\[\\]+$/;
// The refspecs of a sealed push as <object>:<full name> (or :<full name> to delete), the options that came from the
// push's own, and the refs it moves for the checkout's remote-tracking refs and -u. The commits must be those that the
// broker was told about. A problem names what cannot be written whole.
function sealedRefspecs(env, globalArgs, specs, options, authorized, name, listed) {
  const read = (...args) => (gitOutput(env, globalArgs, args) || '').trim();
  const shas = authorized.shas || [];
  const refspecs = [], updates = [];
  const unnamed = { problem: 'a ref it names cannot be written as a full name' };
  const changed = { problem: 'the commits it names are not the ones that the broker was told' };
  let used = 0;
  for (const raw of specs) {
    const force = raw.startsWith('+') ? '+' : '';
    const body = force ? raw.slice(1) : raw;
    if (raw === 'tag' || body.startsWith('^') || /[*?[]/.test(body)) return { problem: 'the refspec ' + raw.slice(0, 60) + ' cannot be listed' };
    const colon = body.indexOf(':');
    let source = colon < 0 ? body : body.slice(0, colon), destination = colon < 0 ? '' : body.slice(colon + 1);
    if (options.deleting) { if (colon >= 0 || !body) return unnamed; source = ''; destination = body; }
    if (!source) {
      // A deletion names the ref it deletes; a name without refs/ is a branch.
      const full = destination.startsWith('refs/') ? destination : 'refs/heads/' + destination;
      if (!destination || !WHOLE_REF.test(full)) return unnamed;
      refspecs.push(':' + full);
      updates.push({ destination: full, sha: null, local: null });
      continue;
    }
    // The object is what the ref is (a tag object stays one), the commit is what the broker was told.
    const object = read('rev-parse', '--verify', '-q', source);
    const commit = read('rev-parse', '--verify', '-q', source + '^{commit}');
    const named = read('rev-parse', '--symbolic-full-name', source).split('\n').filter(Boolean);
    const full = named.length === 1 && /^refs\/(heads|tags)\//.test(named[0]) ? named[0] : '';
    if (!/^[0-9a-f]{40,64}$/.test(object) || !commit || commit !== shas[used]) return changed;
    used += 1;
    // A branch goes to a branch and a tag to a tag, as git does for a name without refs/; no name goes to the source's own.
    const target = !destination ? full : destination.startsWith('refs/') ? destination : full ? full.slice(0, full.indexOf('/', 5) + 1) + destination : '';
    if (!WHOLE_REF.test(target) || target.split('/').some(part => part === '' || part === '.' || part === '..')) return unnamed;
    refspecs.push(force + object + ':' + target);
    updates.push({ destination: target, sha: object, local: full.startsWith('refs/heads/') ? full : null });
  }
  if (used !== shas.length) return changed;
  // --force-with-lease as an expected old value per ref. A commit that the command names (or none, for a ref that must not
  // exist) is used as it is. A value that comes out of this checkout's refs (the remote-tracking ref that a lease without a
  // value means, or a name such as origin/x) is the agent's to write, so it is only taken when it is what GitHub lists for the
  // branch, and the child is given the listed commit: a checkout that disagrees with GitHub is refused, as git refuses a
  // lease whose remote has moved. listed() is GitHub's branches as read for the check, else as read now.
  const flags = [...options.flags];
  for (const lease of options.leases) {
    const colon = lease === undefined ? -1 : lease.indexOf(':');
    const ref = lease === undefined ? '' : colon < 0 ? lease : lease.slice(0, colon);
    const asked = ref ? [ref.startsWith('refs/') ? ref : 'refs/heads/' + ref] : updates.map(update => update.destination);
    for (const target of asked) {
      if (!WHOLE_REF.test(target)) return unnamed;
      let expected = '', fromRefs = true;
      if (colon >= 0) {
        const value = lease.slice(colon + 1);
        fromRefs = !!value && !/^[0-9a-f]{40,64}$/.test(value);
        expected = fromRefs ? read('rev-parse', '--verify', '-q', value) : value;
        if (fromRefs && !expected) return { problem: 'the value that ' + target.slice(0, 60) + ' is expected to have cannot be read' };
      } else if (name && target.startsWith('refs/heads/')) {
        expected = read('rev-parse', '--verify', '-q', 'refs/remotes/' + name + '/' + target.slice(11));
      } else return { problem: 'the value that ' + target.slice(0, 60) + ' is expected to have is not known (name it: --force-with-lease=<ref>:<commit>)' };
      if (fromRefs) {
        const heads = target.startsWith('refs/heads/') ? listed() : undefined;
        if (heads === undefined) return { problem: 'the value that ' + target.slice(0, 60) + ' is expected to have comes from this checkout and is not a branch (name it: --force-with-lease=<ref>:<commit>)' };
        if (heads === null) return { problem: 'the branches GitHub has could not be read, so what --force-with-lease expects of ' + target.slice(0, 60) + ' cannot be tied to them', advice: 'Run it again.' };
        // Equal, so the value in the child's arguments is the one GitHub listed.
        if ((heads.get(target.slice(11)) || '') !== expected) return { problem: target.slice(0, 60) + ' on GitHub is not where this checkout last saw it, so --force-with-lease would refuse it', advice: 'Fetch, look at what is new on that branch, and run it again.' };
      }
      flags.push('--force-with-lease=' + target + ':' + expected);
    }
  }
  return { refspecs, flags, updates };
}
// The command, environment and private git directory of the sealed push, or { problem, advice }. authorized is the report
// that the broker answered with a credential: the sealed push must send exactly what it described, to the one URL it
// listed. listing is GitHub's branches as read for the check of that report (null when they were not read). Everything it reads
// of the checkout is read with local, the environment without the credential.
function sealedPush(env, local, globalArgs, pushArgs, authorized, scratch, listing) {
  const options = sealedOptions(pushArgs);
  if (options.problem) return { problem: options.problem };
  const { positional, repoOption } = gitNetworkArgs('push', pushArgs);
  if (JSON.stringify(positional) !== JSON.stringify(options.rest)) return { problem: 'its arguments cannot be read the way git reads them' };
  const branch = gitOutput(local, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const where = pushTarget(local, globalArgs, positional, repoOption, branch ? branch.trim() : '', (key, type) => gitConfigValue(local, globalArgs, key, type) || '');
  const url = where.allUrls.length === 1 ? where.allUrls[0] : '';
  const reported = authorized.pushUrls || [];
  if (!url || /[\x00-\x1f]/.test(url) || reported.length !== 1 || reported[0] !== url) return { problem: 'it does not go to exactly one destination that the broker was told' };
  // Repository config (push.default, a remote's push refspecs or mirror) decides which refs a push without refspecs sends.
  if (authorized.implicitPush) return { problem: 'repository configuration decides which refs it sends' };
  const name = where.configured.length ? where.target : null;
  // Without refspecs git pushes the current branch (the broker was told so: it saw HEAD), and a deletion names its refs.
  const specs = positional.length > 1 || options.deleting ? positional.slice(1) : ['HEAD'];
  // The branches GitHub lists for a lease to be tied to: those the check read, else read now (null when they cannot be).
  let fetched;
  const listed = () => {
    if (listing) return listing.heads;
    if (fetched === undefined) fetched = remoteRefs(env, local, globalArgs, scratch, url);
    return fetched ? fetched.heads : null;
  };
  const planned = sealedRefspecs(local, globalArgs, specs, options, authorized, name, listed);
  if (planned.problem) return planned;
  const dir = privateGit(env, local, globalArgs, scratch, 'push');
  if (!dir) return { problem: 'its private git directory cannot be made' };
  try {
    // The checkout's objects, and its shallow boundary (what a push of a shallow checkout leaves out).
    const place = what => (gitOutput(local, globalArgs, ['rev-parse', '--path-format=absolute', '--git-path', what]) || '').trim();
    const objects = place('objects');
    if (!objects) return { problem: 'the objects of this checkout cannot be located' };
    const more = (local.GIT_ALTERNATE_OBJECT_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map(other => path.resolve(other));
    fs.mkdirSync(path.join(dir.gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir.gitDir, 'objects', 'info', 'alternates'), [objects, ...more].join('\n') + '\n');
    const shallow = place('shallow');
    if (shallow && fs.existsSync(shallow)) fs.copyFileSync(shallow, path.join(dir.gitDir, 'shallow'));
    lockPrivateGit(dir, false);
    return {
      args: [...SEALED_CONFIG(dir), '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no',
        'push', ...planned.flags, '--no-verify', '--no-follow-tags', '--no-recurse-submodules', '--', url, ...planned.refspecs],
      git: dir.git, env: dir.sealed, gitDir: dir.gitDir, name, updates: planned.updates, upstream: options.upstream, dryRun: options.dryRun,
    };
  } catch { return { problem: 'its private git directory cannot be made' }; }
}
// What git does for a push to a configured remote, done in the checkout after the sealed push (it went to a URL, so git
// did none of it): the remote-tracking refs of the branches it moved or deleted, and the upstream that -u records.
function sealedSync(env, globalArgs, plan, code) {
  try { fs.chmodSync(plan.gitDir, 0o700); } catch {}
  if (code !== 0 || plan.dryRun || !plan.name) return;
  try {
    for (const update of plan.updates) {
      if (!update.destination.startsWith('refs/heads/')) continue;
      const tracking = 'refs/remotes/' + plan.name + '/' + update.destination.slice(11);
      gitRun(env, globalArgs, update.sha ? ['update-ref', tracking, update.sha] : ['update-ref', '-d', tracking]);
    }
    if (plan.upstream) {
      for (const update of plan.updates) {
        if (!update.local) continue;
        gitRun(env, globalArgs, ['config', 'branch.' + update.local.slice(11) + '.remote', plan.name]);
        gitRun(env, globalArgs, ['config', 'branch.' + update.local.slice(11) + '.merge', update.destination]);
      }
    }
  } catch {}
}
// A fetch or an ls-remote that holds the credential is sealed like a push: it reads from the one URL the broker was told, in a
// git directory of its own (see privateGit), with an environment of its own and no hooks. The checkout's remote names, config
// and hooks are not consulted after the check. A fetch keeps the refs, FETCH_HEAD and shallow boundary of the checkout up to
// date afterwards, with processes that do not hold the credential (sealedFetchFinish). A pull is not run: it fetches and then
// merges in one command, and the merge runs this checkout's hooks and config. Whatever cannot be reduced to one URL and one
// list of refs is refused, with the reason.
const FETCH_OPTIONS = {
  flags: ['--quiet', '--no-quiet', '--verbose', '--no-verbose', '--progress', '--no-progress', '--ipv4', '--ipv6', '--force', '--prune', '--prune-tags', '--no-tags', '--tags',
    '--keep', '--dry-run', '--atomic', '--unshallow', '--update-shallow', '--update-head-ok', '--show-forced-updates', '--no-show-forced-updates', '--write-fetch-head',
    '--no-write-fetch-head', '--porcelain', '--append'],
  values: ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--refmap', '--server-option', '--negotiation-tip'],
  // Done by the sealed fetch whatever was asked: no submodules (their remotes were never checked), no maintenance of the checkout.
  dropped: ['--no-recurse-submodules', '--recurse-submodules', '--auto-gc', '--no-auto-gc', '--auto-maintenance', '--no-auto-maintenance', '--write-commit-graph', '--no-write-commit-graph'],
  dropValue: ['--jobs', '--recurse-submodules-default', '--submodule-prefix'],
  short: { q: '--quiet', v: '--verbose', 4: '--ipv4', 6: '--ipv6', f: '--force', p: '--prune', P: '--prune-tags', n: '--no-tags', t: '--tags', k: '--keep', u: '--update-head-ok', a: '--append' },
  valueShort: { j: 'drop', o: '--server-option' },
  refused: {
    '--all': 'fetches from several remotes, and each needs its own URL', '--multiple': 'fetches from several remotes, and each needs its own URL',
    '--upload-pack': 'runs a program of its own while it holds the credential', '--filter': 'needs the settings of a partial clone, which a sealed fetch does not have',
    '--refetch': 'is not done by a sealed fetch', '--prefetch': 'is not done by a sealed fetch', '--stdin': 'is not done by a sealed fetch',
    '--negotiate-only': 'is not done by a sealed fetch', '--set-upstream': 'is not done by a sealed fetch',
  },
};
const LS_REMOTE_OPTIONS = {
  flags: ['--quiet', '--heads', '--branches', '--tags', '--refs', '--exit-code', '--get-url', '--symref', '--ipv4', '--ipv6'],
  values: ['--sort', '--server-option'], dropped: [], dropValue: [],
  short: { q: '--quiet', h: '--heads', t: '--tags', 4: '--ipv4', 6: '--ipv6' }, valueShort: { o: '--server-option' },
  refused: { '--upload-pack': 'runs a program of its own while it holds the credential', '--exec': 'runs a program of its own while it holds the credential' },
};
// The options of a sealed fetch or ls-remote, from a table: forwarded in their long form, dropped (the sealed command does them
// itself), or refused. rest is what is left: the repository and its refspecs or patterns.
function sealedReadOptions(table, args) {
  const flags = [], rest = [];
  let append = false, updateHeadOk = false;
  const missing = { problem: 'an option is missing its value' };
  const flag = name => { if (name === '--append') append = true; else flags.push(name); if (name === '--update-head-ok') updateHeadOk = true; };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--') { rest.push(...args.slice(at + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { rest.push(arg); continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals), attached = equals < 0 ? undefined : arg.slice(equals + 1);
      if (table.refused[name]) return { problem: 'the option ' + name + ' ' + table.refused[name] };
      if (table.dropped.includes(name)) continue;
      if (table.dropValue.includes(name)) { if (attached === undefined) at++; continue; }
      if (table.values.includes(name)) {
        const value = attached === undefined ? args[++at] : attached;
        if (value === undefined) return missing;
        flags.push(name + '=' + value);
        continue;
      }
      if (table.flags.includes(name) && attached === undefined) { flag(name); continue; }
      return { problem: 'the option ' + name.slice(0, 40) + ' cannot be reduced to one URL and one list of refs' };
    }
    for (let i = 1; i < arg.length; i++) {
      const value = table.valueShort[arg[i]];
      if (value) {
        const given = i + 1 < arg.length ? arg.slice(i + 1) : args[++at];
        if (given === undefined) return missing;
        if (value !== 'drop') flags.push(value + '=' + given);
        break;
      }
      if (!table.short[arg[i]]) return { problem: 'the option -' + arg[i] + ' cannot be reduced to one URL and one list of refs' };
      flag(table.short[arg[i]]);
    }
  }
  return { flags, rest, append, updateHeadOk };
}
// The values of a config key that can be set more than once: [] when unset, null when git could not tell.
function gitConfigValues(env, globalArgs, key) {
  const result = gitRun(env, globalArgs, ['config', '-z', '--get-all', key]);
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : result.status === 1 ? [] : null;
}
// The one URL a fetch or ls-remote reads from: the URL given as the target, or the URL of the configured remote that is named
// (or that git defaults to), which must be the one the broker was told. name is that remote, if it is one.
function readTarget(local, globalArgs, given, branch, authorized) {
  const target = given || (branch && gitConfigValue(local, globalArgs, 'branch.' + branch + '.remote')) || 'origin';
  // A configured remote name first, as git does (and as a push does); otherwise the target is itself a URL or a path.
  const url = !target.includes(':') && REMOTE_NAME.test(target) ? remoteUrl(local, globalArgs, target, false) : null;
  if (url) {
    if (url !== authorized.remote) return { problem: 'its remote ' + target.slice(0, 60) + ' is not the repository that the broker was told about', advice: 'Name the remote that you mean (git fetch <remote>) and run it again.' };
    return { url, name: target };
  }
  if (!/[:/]/.test(target)) return { problem: target.slice(0, 60) + ' is neither a configured remote nor a URL' };
  if (/[\x00-\x1f]/.test(target) || target.length > 1000) return { problem: 'its destination cannot be read' };
  return { url: target, name: null };
}
// Every ref of a repository as name -> commit, and the symbolic ones as name -> target: null when git could not list them.
function readRefs(env, globalArgs) {
  const git = gitBinary();
  if (!git) return null;
  const result = require('node:child_process').spawnSync(git, [...globalArgs, 'for-each-ref', '--format=%(objectname) %(refname) %(symref)'],
    { env, encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) return null;
  const refs = new Map(), symbolic = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const [sha, name, symref] = line.split(' ');
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !name) return null;
    if (symref) symbolic.set(name, symref); else refs.set(name, sha);
  }
  return { refs, symbolic };
}
function sealedLsRemote(env, local, globalArgs, lsArgs, authorized, scratch) {
  const options = sealedReadOptions(LS_REMOTE_OPTIONS, lsArgs);
  if (options.problem) return { problem: options.problem, advice: 'List one remote (git ls-remote <remote> [<pattern>]) without other options.' };
  if (JSON.stringify(gitNetworkArgs('ls-remote', lsArgs).positional) !== JSON.stringify(options.rest)) return { problem: 'its arguments cannot be read the way git reads them' };
  const branch = (gitOutput(local, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']) || '').trim();
  const target = readTarget(local, globalArgs, options.rest[0], branch, authorized);
  if (target.problem) return target;
  const dir = privateGit(env, local, globalArgs, scratch, 'ls');
  if (!dir) return { problem: 'its private git directory cannot be made' };
  try {
    lockPrivateGit(dir, false);
    return {
      args: [...SEALED_CONFIG(dir), 'ls-remote', ...options.flags, '--', target.url, ...options.rest.slice(1)],
      git: dir.git, env: dir.sealed, gitDir: dir.gitDir, finish: code => code,
    };
  } catch { return { problem: 'its private git directory cannot be made' }; }
}
// A fetch runs in a git directory that has the checkout's refs (so that git negotiates, fast-forwards, follows tags and prunes as
// it does in the checkout), its shallow boundary, and the checkout's object directory (so that what it fetches lands there).
// What git needs to know about the remote comes as environment config of this launcher's own: the URL the broker was told,
// where its branches go, tag and prune settings, and the upstream of the current branch. Nothing is read from a file the agent
// could change as the command starts. Afterwards the refs it changed, FETCH_HEAD and the shallow boundary are applied to the
// checkout by processes that do not hold the credential.
function sealedFetch(env, local, globalArgs, fetchArgs, authorized, scratch) {
  const options = sealedReadOptions(FETCH_OPTIONS, fetchArgs);
  if (options.problem) return { problem: options.problem, advice: 'Fetch one remote at a time, by name (git fetch <remote> [<refspec>]), without other options.' };
  if (JSON.stringify(gitNetworkArgs('fetch', fetchArgs).positional) !== JSON.stringify(options.rest)) return { problem: 'its arguments cannot be read the way git reads them' };
  const branch = (gitOutput(local, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']) || '').trim();
  const target = readTarget(local, globalArgs, options.rest[0], branch, authorized);
  if (target.problem) return target;
  // The objects a partial clone lacks are fetched on demand from a promisor remote, which a private git directory does not know.
  if (gitConfigValue(local, globalArgs, 'extensions.partialclone') !== '') return { problem: 'this checkout is a partial clone' };
  const settings = [];
  let readable = true;
  const copy = key => { const found = gitConfigValues(local, globalArgs, key); if (found === null) readable = false; else for (const value of found) settings.push([key, value]); };
  if (target.name) {
    settings.push(['remote.' + target.name + '.url', target.url]);
    for (const key of ['fetch', 'tagopt', 'prune', 'pruneTags', 'followRemoteHEAD']) copy('remote.' + target.name + '.' + key);
  }
  for (const key of ['fetch.prune', 'fetch.pruneTags']) copy(key);
  if (branch) for (const key of ['remote', 'merge']) copy('branch.' + branch + '.' + key);
  if (!readable) return { problem: 'its configuration cannot be read' };
  const place = what => (gitOutput(local, globalArgs, ['rev-parse', '--path-format=absolute', '--git-path', what]) || '').trim();
  const objects = place('objects');
  if (!objects) return { problem: 'the objects of this checkout cannot be located' };
  const seed = readRefs(local, globalArgs);
  if (!seed) return { problem: 'its refs cannot be read' };
  const dir = privateGit(env, local, globalArgs, scratch, 'fetch');
  if (!dir) return { problem: 'its private git directory cannot be made' };
  try {
    const lines = [...seed.refs].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([name, sha]) => sha + ' ' + name);
    fs.writeFileSync(path.join(dir.gitDir, 'packed-refs'), '# pack-refs with: sorted \n' + (lines.length ? lines.join('\n') + '\n' : ''));
    if (branch) fs.writeFileSync(path.join(dir.gitDir, 'HEAD'), 'ref: refs/heads/' + branch + '\n');
    // Symbolic refs (refs/remotes/<name>/HEAD) stay symbolic, so that git creates, follows and warns about them as it does.
    for (const [name, to] of seed.symbolic) {
      if (!/^refs\/[^\s~^:?*\[\\]+$/.test(name) || !/^refs\/[^\s~^:?*\[\\]+$/.test(to)) continue;
      fs.mkdirSync(path.dirname(path.join(dir.gitDir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir.gitDir, name), 'ref: ' + to + '\n');
    }
    const shallowFile = place('shallow');
    const shallowBefore = shallowFile && fs.existsSync(shallowFile) ? fs.readFileSync(shallowFile, 'utf8') : null;
    if (shallowBefore !== null) fs.writeFileSync(path.join(dir.gitDir, 'shallow'), shallowBefore);
    lockPrivateGit(dir, true);
    const inside = { ...local, GIT_DIR: dir.gitDir, GIT_OBJECT_DIRECTORY: objects, GIT_NO_LAZY_FETCH: '1' };
    const child = { ...dir.sealed, GIT_OBJECT_DIRECTORY: objects, GIT_NO_LAZY_FETCH: '1' };
    if (local.GIT_ALTERNATE_OBJECT_DIRECTORIES) child.GIT_ALTERNATE_OBJECT_DIRECTORIES = local.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    for (const [key, value] of settings) appendGitConfig(child, key, value);
    // The reflog line names the remote, never a URL's user and password.
    const message = 'fetch ' + (target.name || target.url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\/@]*@/i, '$1')).slice(0, 200);
    const plan = { dir, inside, seed, options, shallowFile, shallowBefore, fetchHeadFile: place('FETCH_HEAD'), message };
    return {
      // Maintenance (gc, commit graphs) would work on the checkout's objects from this directory's refs, which are not all of its refs.
      args: [...SEALED_CONFIG(dir), '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', ...options.flags, '--no-recurse-submodules', '--', target.name || target.url, ...options.rest.slice(1)],
      git: dir.git, env: child, gitDir: dir.gitDir, finish: code => sealedFetchFinish(local, globalArgs, plan, code),
    };
  } catch { return { problem: 'its private git directory cannot be made' }; }
}
// Applies what a sealed fetch did to the checkout, without the credential: the refs it changed (each only if the checkout still
// has the value the fetch started from), FETCH_HEAD, and the shallow boundary. Returns the exit code of the fetch command.
function sealedFetchFinish(local, globalArgs, plan, code) {
  const { spawnSync } = require('node:child_process');
  const git = gitBinary();
  const { dir, seed, options } = plan;
  try { fs.chmodSync(dir.gitDir, 0o700); } catch {}
  let failed = code !== 0;
  const complain = text => { failed = true; process.stderr.write('Paperclip: ' + text + '\n'); };
  try {
    const after = readRefs(plan.inside, []);
    if (!after) { complain('the refs that this fetch changed could not be read, so they were not applied to the checkout'); return code || 1; }
    const changes = [];
    for (const [name, sha] of after.refs) if (seed.refs.get(name) !== sha) changes.push({ name, old: seed.refs.get(name) || null, sha });
    for (const [name, old] of seed.refs) if (!after.refs.has(name)) changes.push({ name, old, sha: null });
    // git does not fetch into a branch that is checked out (a worktree's HEAD) unless it is told to: it stops before it changes
    // anything. This fetch has already run, so nothing of it is applied to the checkout.
    const checkedOut = new Map();
    let worktree = '';
    for (const line of (gitOutput(local, globalArgs, ['worktree', 'list', '--porcelain']) || '').split('\n')) {
      if (line.startsWith('worktree ')) worktree = line.slice(9);
      else if (line.startsWith('branch ')) checkedOut.set(line.slice(7), worktree);
    }
    const blocked = options.updateHeadOk ? undefined : changes.find(change => !seed.symbolic.has(change.name) && checkedOut.has(change.name));
    if (blocked) {
      process.stderr.write('fatal: refusing to fetch into branch \'' + blocked.name + '\' checked out at \'' + checkedOut.get(blocked.name) + '\'\n');
      return 128;
    }
    const applied = changes.filter(change => !seed.symbolic.has(change.name));
    const run = (args, input, quiet) => spawnSync(git, [...globalArgs, 'update-ref', '-m', plan.message, ...args], { env: local, encoding: 'utf8', input, timeout: 120000, stdio: ['pipe', 'ignore', quiet ? 'ignore' : 'inherit'] }).status === 0;
    const zero = change => '0'.repeat((change.sha || change.old).length);
    if (applied.length && !run(['--stdin'], applied.map(change => change.sha === null ? 'delete ' + change.name + ' ' + change.old + '\n'
      : change.old === null ? 'create ' + change.name + ' ' + change.sha + '\n' : 'update ' + change.name + ' ' + change.sha + ' ' + change.old + '\n').join(''), true)) {
      // One that cannot be updated (someone else moved it meanwhile) does not stop the others, as with git.
      for (const change of applied) {
        const done = change.sha === null ? run(['-d', change.name, change.old], undefined, false) : run([change.name, change.sha, change.old || zero(change)], undefined, false);
        if (!done) complain('could not update ' + change.name + ' in the checkout');
      }
    }
    // A symbolic ref that git created or pointed elsewhere (refs/remotes/<name>/HEAD).
    for (const [name, to] of after.symbolic) {
      if (seed.symbolic.get(name) === to || seed.refs.has(name)) continue;
      const done = spawnSync(git, [...globalArgs, 'symbolic-ref', '-m', plan.message, name, to], { env: local, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;
      if (!done) complain('could not update ' + name + ' in the checkout');
    }
    const fetched = path.join(dir.gitDir, 'FETCH_HEAD');
    if (plan.fetchHeadFile && fs.existsSync(fetched)) {
      if (options.append) fs.appendFileSync(plan.fetchHeadFile, fs.readFileSync(fetched, 'utf8')); else fs.writeFileSync(plan.fetchHeadFile, fs.readFileSync(fetched, 'utf8'));
    }
    const shallowNow = path.join(dir.gitDir, 'shallow');
    const shallowAfter = fs.existsSync(shallowNow) ? fs.readFileSync(shallowNow, 'utf8') : null;
    if (shallowAfter !== plan.shallowBefore) {
      const current = plan.shallowFile && fs.existsSync(plan.shallowFile) ? fs.readFileSync(plan.shallowFile, 'utf8') : null;
      if (current !== plan.shallowBefore) complain('the shallow boundary of the checkout changed while this fetch ran, so its new boundary was not applied');
      else if (shallowAfter === null) fs.rmSync(plan.shallowFile, { force: true });
      else { fs.writeFileSync(plan.shallowFile + '.paperclip', shallowAfter); fs.renameSync(plan.shallowFile + '.paperclip', plan.shallowFile); }
    }
  } catch { complain('the result of this fetch could not be applied to the checkout'); }
  return code === 0 && failed ? 1 : code;
}
// The git commands that run sealed when they hold a credential, and the ones that reach the network and are not sealed, which
// never run with one: a clone (templates, hooks, filters, submodules, upload-pack), a submodule add or update (it clones or
// fetches each submodule with the checkout's config) and the Git LFS verbs that transfer or lock objects (a transfer agent and
// a credential helper of its own). A pull is refused with its own explanation, where the sealed plan is made. The local verbs
// of a submodule and of Git LFS run as they did.
const SEALED_COMMANDS = ['push', 'fetch', 'ls-remote'];
const LFS_LOCAL_VERBS = ['install', 'uninstall', 'track', 'untrack', 'ls-files', 'env', 'pointer', 'status', 'version', 'help', 'checkout', 'fsck', 'ext',
  'update', 'merge-driver', 'dedup', 'completion', 'clean', 'smudge', 'filter-process', 'migrate'];
// { command, advice } for a command that reaches the network unsealed, or null.
function unsealedNetwork(subcommand, args) {
  const verb = args.find(arg => !arg.startsWith('-'));
  if (subcommand === 'clone') return { command: 'git clone', advice: 'Fetch it instead, which runs sealed: git init <dir> && cd <dir> && git fetch <url> <branch> && git checkout FETCH_HEAD' };
  if (subcommand === 'submodule' && ['add', 'update'].includes(verb)) {
    return { command: 'git submodule ' + verb, advice: 'Fetch the submodule\'s repository yourself, which runs sealed: git init <path> && cd <path> && git fetch <url> <commit> && git checkout FETCH_HEAD' };
  }
  if (subcommand === 'lfs' && verb !== undefined && !LFS_LOCAL_VERBS.includes(verb)) {
    return { command: 'git lfs ' + verb.slice(0, 40), advice: 'Git LFS objects cannot be transferred with a GitHub credential from here yet; the local Git LFS commands still run.' };
  }
  return null;
}
// known: the refs GitHub lists for a push's destination, once read (see pushReport).
function operation(env, known) {
  let remote = null, extra = {};
  if (program === 'git') {
    let index = 0;
    while (index < argv.length && argv[index].startsWith('-')) index += GIT_GLOBAL_WITH_VALUE.includes(argv[index]) ? 2 : 1;
    const globalArgs = argv.slice(0, index);
    if (GIT_REMOTE_COMMANDS.includes(argv[index])) {
      const network = ['push', 'fetch', 'pull', 'ls-remote'].includes(argv[index]);
      const target = network ? gitNetworkTarget(argv[index], argv.slice(index + 1)) : undefined;
      // A remote name is resolved; a URL (it has a colon) or a path that names no remote is reported as given.
      remote = target && target.includes(':') ? null : remoteUrl(env, globalArgs, target || 'origin', argv[index] === 'push' || !network);
    }
    if (argv[index] === 'push') extra = pushReport(env, globalArgs, argv.slice(index + 1), known);
    if (['push', 'fetch', 'pull', 'ls-remote', 'clone'].includes(argv[index]) && foreignRewrites(env, globalArgs)) extra = { ...extra, urlRewrites: true };
  } else if (!argv.some(arg => arg === '-R' || arg === '--repo' || /^(--repo=|-R.)/.test(arg))) {
    // GH_REPO is reported as named. The checkout's remotes and saved default are reported too, GH_REPO or not:
    // some gh commands (gh repo view, edit, fork…) ignore GH_REPO and act on them.
    if (env.GH_REPO) extra = { ghRepo: env.GH_REPO.slice(0, 1000) };
    remote = remoteUrl(env, [], 'origin');
    // gh may pick any remote (upstream first, or its saved default), so report them all.
    const all = [...new Set((gitOutput(env, [], ['remote', '-v']) || '').split('\n')
      .map(line => line.split(/\s+/)[1]).filter(Boolean))];
    const remotes = all.slice(0, 16);
    if (remotes.length > 1) extra = { ...extra, remotes, ...(all.length > 16 ? { truncated: true } : {}) };
    // gh's saved default repository (gh repo set-default, remote.<name>.gh-resolved) wins over the remotes.
    const saved = gitRun(env, [], ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']);
    if (saved.status !== 0 && saved.status !== 1) extra = { ...extra, truncated: true };
    const resolved = saved.stdout.split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean);
    if (resolved.length) extra = { ...extra, ghResolved: resolved.slice(0, 16).map(value => value.slice(0, 1000)), ...(resolved.length > 16 ? { truncated: true } : {}) };
  }
  // Report the whole command; if it is too large, say so instead of cutting it silently. The text of a
  // PR or issue body, title or notes decides nothing: a long one is cut (its start is still checked) without
  // refusing the command.
  const GH_TEXT_FLAGS = ['--body', '-b', '--title', '--notes', '--description'];
  const text = at => program === 'gh' && (GH_TEXT_FLAGS.includes(argv[at - 1]) || /^--(body|title|notes|description)=/.test(argv[at]));
  const truncated = argv.length > 256 || argv.some((arg, at) => arg.length > 8192 && !text(at));
  return { program, args: argv.slice(0, 256).map(arg => arg.slice(0, 8192)), remote, ...extra, ...(truncated ? { truncated: true } : {}) };
}
// Without a managed credential, a gh command that may write never runs: an
// ambient gh wrapper could otherwise write as a bot. The grammar is the broker
// classifier's own (packages/shared/src/gh-command.ts), embedded unchanged: the
// classifier answers a plain, unrefused read for every command this answers
// false for. Any doubt, or an error, means it may write.
const parseGhCommand = ${parseGhCommand.toString()};
const ghCommandMayWrite = ${ghCommandMayWrite.toString()};
function ghMayWrite(args) {
  try { return ghCommandMayWrite(parseGhCommand(args)) !== false; } catch { return true; }
}
// A gh command that prints a credential never runs, with or without one: an ambient gh wrapper's token would print too.
function ghPrintsToken(args) {
  try { return parseGhCommand(args).printsToken !== false; } catch { return true; }
}
// A gh command that names a host other than github.com never runs without a
// managed credential either: an ambient gh wrapper could send its token there.
const GITHUB_HOSTS = ['github.com', 'www.github.com', 'api.github.com'];
function ghNamesOtherHost(args) {
  return args.some((arg, index) => {
    const host = arg === '--hostname' ? args[index + 1] : arg.startsWith('--hostname=') ? arg.slice(11) : null;
    if (host !== null) return String(host).trim().toLowerCase() !== 'github.com';
    const repo = arg === '-R' || arg === '--repo' ? args[index + 1] : (/^(?:--repo=|-R=?)(.+)$/.exec(arg) || [])[1];
    if (repo !== undefined && String(repo).split('/').length > 2 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) return String(repo).split('/')[0].toLowerCase() !== 'github.com';
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? arg : repo && /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) ? repo : null;
    if (url === null) return false;
    try { return !GITHUB_HOSTS.includes(new URL(url).hostname.toLowerCase()); } catch { return true; }
  });
}
// Agents may act as a person's GitHub account. When the company asks for it,
// their PR and issue text is marked so that person can tell agent work from
// their own; the GitHub actor itself is unchanged. Commits are never rewritten.
const GH_BODY_COMMANDS = { pr: ['create', 'new', 'comment', 'review', 'edit'], issue: ['create', 'new', 'comment', 'edit'] };
// Rewrites the body of a gh command. A body file is copied into the operation's
// private scratch directory instead of being edited. Returns null when the body
// cannot be read, so the caller runs the command unchanged.
function rewriteGhBody(args, transform, addWhenMissing, scratch) {
  const out = args.slice(0, 2);
  let found = false;
  const bodyFile = (file) => {
    if (!scratch || (file === '-' && process.stdin.isTTY)) return null;
    const copy = path.join(scratch, 'body-' + process.pid + '-' + out.length + '.md');
    fs.writeFileSync(copy, transform(fs.readFileSync(file === '-' ? 0 : file, 'utf8')), { mode: 0o600 });
    return copy;
  };
  try {
    for (let index = 2; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--') { out.push(...args.slice(index)); break; }
      const body = /^(?:--body=|-b=?)([\s\S]+)$/.exec(arg);
      const file = /^(?:--body-file=|-F=?)([\s\S]+)$/.exec(arg);
      if ((arg === '--body' || arg === '-b') && index + 1 < args.length) { found = true; out.push('--body', transform(args[++index])); }
      else if (body && arg !== '--body' && arg !== '-b') { found = true; out.push('--body', transform(body[1])); }
      else if ((arg === '--body-file' || arg === '-F') && index + 1 < args.length) {
        const copy = bodyFile(args[++index]);
        if (!copy) return null;
        found = true; out.push('--body-file', copy);
      } else if (file && arg !== '--body-file' && arg !== '-F') {
        const copy = bodyFile(file[1]);
        if (!copy) return null;
        found = true; out.push('--body-file', copy);
      } else out.push(arg);
    }
  } catch { return null; }
  if (!found && addWhenMissing) out.push('--body', transform(''));
  return out;
}
function attributedArgs(args, attribution, scratch) {
  if (program !== 'gh' || !(GH_BODY_COMMANDS[args[0]] || []).includes(args[1])) return args;
  const footer = '_Posted by Paperclip agent ' + attribution.agentName + ' (run ' + attribution.runId + ')._';
  const approving = args[1] === 'review' && args.some(arg => arg === '-a' || arg === '--approve');
  return rewriteGhBody(args, body => body.includes(footer) ? body : (body.trim() ? body.replace(/\s+$/, '') + '\n\n---\n' : '') + footer,
    approving, scratch) || args;
}
// GitHub rejects APPROVE and REQUEST_CHANGES from a pull request's own author.
// Agents opening PRs as a person's account then post the verdict as a comment review.
const SELF_REVIEW_VERDICTS = { '-a': 'approve', '--approve': 'approve', '-r': 'request changes', '--request-changes': 'request changes' };
function selfReviewFallbackArgs(args, scratch) {
  const flag = args.find(arg => SELF_REVIEW_VERDICTS[arg]);
  const verdict = SELF_REVIEW_VERDICTS[flag];
  const prefix = '**Review verdict: ' + verdict + '.** GitHub does not let an author '
    + (verdict === 'approve' ? 'approve their own pull request' : 'request changes on their own pull request')
    + ', so this verdict is posted as a comment review.';
  return rewriteGhBody([...args.filter(arg => arg !== flag), '--comment'],
    body => body.trim() ? prefix + '\n\n' + body : prefix, true, scratch);
}
// A bridged sandbox reaches Paperclip only through its callback bridge
// (PAPERCLIP_API_URL); the server's public broker URL may not even resolve
// there. Other runs keep the broker URL first. A transport failure moves on
// to the other route; HTTP answers, including a rejected capability, never do.
// Returns null without a capability; throws when every route stays unreachable.
async function brokerPost(env, route, body) {
  const routes = env.PAPERCLIP_API_BRIDGE_MODE
    ? [env.PAPERCLIP_API_URL, env.PAPERCLIP_GITHUB_BROKER_URL]
    : [env.PAPERCLIP_GITHUB_BROKER_URL, env.PAPERCLIP_API_URL];
  const urls = [...new Set(routes.filter(Boolean)
    .map(base => {
      let end = base.length;
      while (end > 0 && base.charCodeAt(end - 1) === 47) end -= 1;
      return base.slice(0, end).replace(/\/api$/, '') + route;
    }))];
  if (!urls.length || !env.PAPERCLIP_GITHUB_BROKER_TOKEN) return null;
  // A slow or restarting control plane must not cost the operation its
  // managed identity, so a failed request is retried before giving up.
  // Busy (409) responses and transport failures keep separate budgets, and
  // the body is read inside the retry so a failed read is retried too.
  // Only the last route spends the transport budget.
  let transportFailures = 0, conflicts = 0, index = 0, response, result;
  for (;;) {
    try {
      response = await fetch(urls[index], {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
          'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
        body,
      });
      if (response.status === 409 && conflicts < 29) {
        conflicts += 1;
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      // A failed read of a successful answer is retried; an error answer is read best-effort.
      result = response.ok ? await response.json() : await response.json().catch(() => null);
      return { response, result };
    } catch (error) {
      if (index < urls.length - 1) { index += 1; continue; }
      transportFailures += 1;
      if (transportFailures >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * transportFailures));
    }
  }
}
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
// git calls this as gpg.ssh.program: "-Y sign -n git -f <key> -U <buffer>".
// The server signs the buffer with the company's key; the key never leaves it.
// Verification verbs go to the real ssh-keygen.
async function signer() {
  if (argv[0] !== '-Y' || argv[1] !== 'sign') {
    if (!executable) { process.stderr.write('Paperclip: ssh-keygen is not installed.\n'); process.exit(127); }
    const child = spawn(executable, argv, { stdio: 'inherit' });
    child.once('error', () => { process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code === null ? 128 : code; });
    return;
  }
  const buffer = argv[argv.length - 1];
  const fail = reason => { process.stderr.write('Paperclip: commit signing failed: ' + reason + '\n'); process.exit(1); };
  let payload;
  try { payload = fs.readFileSync(buffer); } catch { fail('the object to sign could not be read.'); }
  if (payload.length > 1024 * 1024) fail('the object to sign is larger than 1 MiB.');
  let answered;
  try { answered = await brokerPost(process.env, '/runtime-tools/github/sign', JSON.stringify({ payload: payload.toString('base64') })); }
  catch { fail('Paperclip could not be reached.'); }
  if (!answered) fail('this run has no GitHub capability.');
  const { response, result } = answered;
  if (!response.ok || !result || typeof result.signature !== 'string' || !result.signature.startsWith('-----BEGIN SSH SIGNATURE-----')) {
    fail(clean(result && (result.unavailable || result.error), 500) || ('Paperclip answered ' + response.status + '.'));
  }
  fs.writeFileSync(buffer + '.sig', result.signature, { mode: 0o600 });
}
// URL-specific http.* config (http.https://github.com/….proxy) outranks the launcher's own http.proxy and
// http.sslVerify, so the values git will use for GitHub are read and anything but a direct, verified
// connection refuses the command.
function gitTrustProblem(env, report) {
  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) index += GIT_GLOBAL_WITH_VALUE.includes(argv[index]) ? 2 : 1;
  const globalArgs = argv.slice(0, index);
  const reported = report ? [report.remote, ...(report.pushUrls || [])] : [];
  const urls = [...new Set(['https://github.com/', ...reported.filter(url => typeof url === 'string' && /^https:\/\/(www\.)?github\.com\//i.test(url))])];
  for (const url of urls) {
    for (const key of ['http.proxy', 'http.sslCAInfo', 'http.sslCAPath', 'http.curloptResolve']) {
      const found = gitRun(env, globalArgs, ['config', '--get-urlmatch', key, url]);
      if (found.status === 0 ? found.stdout.trim() !== '' : found.status !== 1) return true;
    }
    const verify = gitRun(env, globalArgs, ['config', '--type=bool', '--get-urlmatch', 'http.sslVerify', url]);
    if (verify.status !== 0 || verify.stdout.trim() !== 'true') return true;
  }
  return false;
}
async function main() {
  if (program === 'gh' && ghPrintsToken(argv)) {
    process.stderr.write('Paperclip: this gh command prints a GitHub credential; Paperclip does not run it.\n');
    process.exit(1);
  }
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  const scratch = configReady ? configDirectory : null;
  let gitAt = 0;
  if (program === 'git') while (gitAt < argv.length && argv[gitAt].startsWith('-')) gitAt += GIT_GLOBAL_WITH_VALUE.includes(argv[gitAt]) ? 2 : 1;
  const gitSubcommand = program === 'git' ? argv[gitAt] : undefined;
  // authorized: the report of the command that the broker last answered with a credential; listing: the branches GitHub
  // listed when that report was checked (see remoteRefs), which the sealed push ties a lease to. readEnv: the environment of
  // the launcher's own reads of the checkout (and of what it applies to it afterwards), as it was before any credential came:
  // no hook, helper or setting of the checkout can see the credential through them.
  let attribution = null, credentialed = false, report = null, authorized = null, listing = null, readEnv = null;
  {
    for (const key of Object.keys(env)) {
      // CODESPACES makes gh send GITHUB_TOKEN to non-github.com hosts. A bare GIT_CONFIG redirects
      // git config (what the report reads) but not git push, so every GIT_CONFIG* goes.
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*|GH_HOST|CODESPACES|GIT_EXEC_PATH)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      // gh talks only to github.com, whatever the run set: GitHub credentials are for github.com alone.
      GH_HOST: 'github.com',
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
      // What a command reports of the history (its commits, their parents and files) is read from the real objects: the
      // replace refs and the grafts of a checkout are the agent's to write, and would show other history than the push
      // sends. (core.graftFile does not turn grafts off; this variable does.)
      GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null',
    });
    readEnv = { ...env };
    const takeCredentials = result => {
      for (const [key, value] of Object.entries(result.env || {})) {
        if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
      }
    };
    let answered = null;
    try {
      report = operation(env);
      answered = await brokerPost(env, '/runtime-tools/github/credentials', JSON.stringify({ operation: report }));
      if (!answered) diagnostic('capability_missing');
    } catch { diagnostic('broker_transport_unavailable'); }
    if (answered && !answered.response.ok) {
      diagnostic(answered.response.status === 401 || answered.response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
    } else if (answered && answered.result) {
      const result = answered.result;
      if (result.attribution && clean(result.attribution.agentName, 200) && clean(result.attribution.runId, 200)) {
        attribution = { agentName: clean(result.attribution.agentName, 200), runId: clean(result.attribution.runId, 200) };
      }
      if (result.status === 'unavailable') {
        const reason = clean(result.reason, 500) || 'Check the GitHub connection in Paperclip';
        if (result.failClosed === true) {
          // A refused write never runs, so no other credential can perform it.
          process.stderr.write('Paperclip: GitHub refused this command: ' + reason + '. It does not run with any other GitHub credential.\n');
          process.exit(1);
        }
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        takeCredentials(result);
        credentialed = true;
        // gh acts on the repository Paperclip checked, never on a saved default (gh-resolved) or another remote.
        if (program === 'gh' && !env.GH_REPO && typeof result.repository === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(result.repository)
          && !argv.some(arg => arg === '-R' || arg === '--repo' || /^(--repo=|-R.)/.test(arg))) env.GH_REPO = result.repository;
        // Commits are signed by Paperclip through the run bridge; no key is on this machine.
        if (typeof result.signingKey === 'string' && /^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(result.signingKey)) {
          let count = Number(env.GIT_CONFIG_COUNT) || 0;
          for (const [key, value] of [['gpg.format', 'ssh'], ['user.signingKey', 'key::' + result.signingKey], ['commit.gpgSign', 'true'], ['gpg.ssh.program', path.join(directory, SIGNER)]]) {
            env['GIT_CONFIG_KEY_' + count] = key; env['GIT_CONFIG_VALUE_' + count] = value; count += 1;
          }
          env.GIT_CONFIG_COUNT = String(count);
        }
      }
    }
    // A push never recurses into submodules, whatever repository config says (submodule.recurse,
    // push.recurseSubmodules): their remotes are not checked. Command-line scope outranks the repository.
    appendGitConfig(env, 'push.recurseSubmodules', 'no');
    // A command holding a GitHub token talks to GitHub directly, with verified TLS: a proxy or another trust
    // store (repository config or the run's environment) could let a TLS-intercepting proxy read the token.
    if (env.GH_TOKEN || env.GITHUB_TOKEN || env.PAPERCLIP_GIT_TOKEN) {
      // A git command holding a token either runs sealed, from a git that the caller's PATH cannot choose, or does not run.
      if (program === 'git') {
        const unsealed = unsealedNetwork(gitSubcommand, argv.slice(gitAt + 1));
        const trusted = SEALED_COMMANDS.includes(gitSubcommand) ? trustedGit() : {};
        if (unsealed || trusted.problem) {
          process.stderr.write('Paperclip: ' + (unsealed ? unsealed.command + ' cannot run with a GitHub credential, because it reaches the network without being sealed. ' + unsealed.advice
            : 'git ' + gitSubcommand + ' cannot run with a GitHub credential, because ' + trusted.problem + '. Install git in a system directory that this user cannot change.') + '\n');
          process.exit(1);
        }
      }
      appendGitConfig(env, 'http.sslVerify', 'true');
      appendGitConfig(env, 'http.proxy', '');
      for (const key of Object.keys(env)) {
        if (/^(https?_proxy|all_proxy|git_ssl_no_verify|git_ssl_cainfo|git_ssl_capath|git_ssl_cert|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs|curl_ca_bundle|requests_ca_bundle|git_proxy_command|git_trace_curl|git_curl_verbose|git_trace_redact)$/i.test(key)) delete env[key];
      }
      // The same settings, read without the credential in the environment.
      const trust = { ...readEnv };
      appendGitConfig(trust, 'http.sslVerify', 'true');
      appendGitConfig(trust, 'http.proxy', '');
      if (program === 'git' && gitTrustProblem(trust, report)) {
        process.stderr.write('Paperclip: this repository sends GitHub traffic through a proxy or with other TLS trust (http.proxy, http.sslVerify, http.sslCAInfo, http.sslCAPath or http.curloptResolve); it does not run with a GitHub credential.\n');
        process.exit(1);
      }
    }
    // A push the checkout reports as free of workflow changes rests on its remote-tracking refs, which the agent can
    // write: a commit that edits a workflow can be hidden behind one that GitHub never had. Before the push runs with a
    // credential, the refs GitHub itself lists decide. If they say it carries workflow changes, or cannot be read, the
    // broker is asked again about the push as they describe it, and its answer replaces the first.
    authorized = credentialed ? report : null;
    if (credentialed && program === 'git' && report && Array.isArray(report.shas) && report.shas.length && report.touchesWorkflows === false) {
      let at = 0;
      while (at < argv.length && argv[at].startsWith('-')) at += GIT_GLOBAL_WITH_VALUE.includes(argv[at]) ? 2 : 1;
      const known = report.pushUrls && report.pushUrls.length === 1 ? remoteRefs(env, readEnv, argv.slice(0, at), scratch, report.pushUrls[0]) : null;
      listing = known;
      const checked = operation(readEnv, known || 'unknown');
      if (checked.touchesWorkflows !== false) {
        if (!known) process.stderr.write('Paperclip: the branches GitHub has could not be read, so this push is treated as one that may change workflow files.\n');
        let second = null;
        try { second = await brokerPost(env, '/runtime-tools/github/credentials', JSON.stringify({ operation: checked })); } catch {}
        const again = second && second.response.ok ? second.result : null;
        if (!again || again.status !== 'available') {
          const reason = clean(again && again.reason, 500) || 'Paperclip could not check this push against GitHub';
          process.stderr.write('Paperclip: GitHub refused this command: ' + reason + '. It does not run with any other GitHub credential.\n');
          process.exit(1);
        }
        takeCredentials(again);
        authorized = checked;
      }
    }
    if (program === 'gh' && !credentialed && ghNamesOtherHost(argv)) {
      process.stderr.write('Paperclip: this gh command names a host other than github.com; it does not run with any other GitHub credential.\n');
      process.exit(1);
    }
    if (program === 'gh' && !credentialed && ghMayWrite(argv)) {
      process.stderr.write('Paperclip: no managed GitHub credential for this gh command, which may write; it does not run with any other GitHub credential.\n');
      process.exit(1);
    }
  }
  // A network command goes where, and sends what, the broker was told. The checkout can change meanwhile (another process,
  // or a config change made while the broker answered), so its remote, refs and commits are read again right before it
  // runs, and it does not run with the credential if they changed.
  if (credentialed && authorized && ['push', 'fetch', 'pull', 'ls-remote'].includes(gitSubcommand)) {
    const now = operation(readEnv, 'unknown');
    if (!['remote', 'pushUrls', 'shas', 'refs', 'currentBranch'].every(key => JSON.stringify(now[key] === undefined ? null : now[key]) === JSON.stringify(authorized[key] === undefined ? null : authorized[key]))) {
      process.stderr.write('Paperclip: the remote or the commits of this command changed while Paperclip checked it, so it does not run with a GitHub credential. Run it again.\n');
      process.exit(1);
    }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = SSH_COMMAND;
  // The launcher's own reads of the checkout, and what it applies to it after a sealed command, run the same way, without the credential.
  Object.assign(readEnv, { PATH: env.PATH, ZDOTDIR: env.ZDOTDIR, BASH_ENV: env.BASH_ENV, GIT_SSH_COMMAND: SSH_COMMAND });
  const args = attribution ? attributedArgs(argv, attribution, scratch) : argv;
  // A git command that goes to the network with a credential runs sealed (see privateGit): a git directory of its own, the URL
  // the broker was told, no hooks, and an environment that carries nothing of the checkout's steering. A push sends one list
  // of refs (sealedPush); a fetch and an ls-remote read from one URL (sealedFetch, sealedLsRemote). A pull is not run: it
  // fetches and then merges in one command, and the merge would run this checkout's hooks and config with the credential.
  let sealedPlan = null;
  if (credentialed && authorized && ['push', 'fetch', 'ls-remote', 'pull'].includes(gitSubcommand)) {
    const globalArgs = argv.slice(0, gitAt), subArgs = argv.slice(gitAt + 1);
    sealedPlan = gitSubcommand === 'push' ? sealedPush(env, readEnv, globalArgs, subArgs, authorized, scratch, listing)
      : gitSubcommand === 'fetch' ? sealedFetch(env, readEnv, globalArgs, subArgs, authorized, scratch)
      : gitSubcommand === 'ls-remote' ? sealedLsRemote(env, readEnv, globalArgs, subArgs, authorized, scratch)
      : { problem: 'it fetches and then merges in one command, and the merge would run this checkout\'s hooks and configuration while it holds the credential',
        advice: 'Run git fetch <remote> <branch>, then git merge FETCH_HEAD (or git rebase <remote>/<branch>) yourself.' };
    if (sealedPlan.problem) {
      const advice = { push: 'Push one branch to one remote (git push <remote> <branch>) without other options.', fetch: 'Fetch one remote at a time, by name (git fetch <remote> [<refspec>]), without other options.',
        'ls-remote': 'List one remote (git ls-remote <remote> [<pattern>]) without other options.' }[gitSubcommand];
      process.stderr.write('Paperclip: ' + (gitSubcommand === 'push' ? 'this push' : 'git ' + gitSubcommand) + ' cannot run with a GitHub credential, because ' + sealedPlan.problem + '. ' + (sealedPlan.advice || advice) + '\n');
      process.exit(1);
    }
  }
  let child = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child && child.kill(signal));
  const run = (args, captureStderr, childEnv = env, binary = executable) => new Promise(resolve => {
    let stderr = '', settled = false;
    const settle = (code) => { if (!settled) { settled = true; resolve({ code, stderr }); } };
    child = spawn(binary, args, { env: childEnv, stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'] });
    if (captureStderr) child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); settle(1); });
    // A captured stderr is complete only once the pipe closes.
    child.once(captureStderr ? 'close' : 'exit', (code) => settle(code === null ? 128 : code));
  });
  const reviewing = program === 'gh' && args[0] === 'pr' && args[1] === 'review' && args.some(arg => SELF_REVIEW_VERDICTS[arg]);
  let result = sealedPlan ? await run(sealedPlan.args, false, sealedPlan.env, sealedPlan.git) : await run(args, reviewing);
  if (sealedPlan && gitSubcommand === 'push') sealedSync(readEnv, argv.slice(0, gitAt), sealedPlan, result.code);
  else if (sealedPlan) result = { ...result, code: sealedPlan.finish(result.code) };
  if (reviewing && result.code !== 0 && /own pull request/i.test(result.stderr)) {
    const fallback = selfReviewFallbackArgs(args, scratch);
    if (fallback) {
      process.stderr.write('Paperclip: GitHub does not allow this verdict on your own pull request; posting it as a comment review.\n');
      result = await run(fallback, false);
    }
  }
  process.exitCode = result.code;
}
(program === SIGNER ? signer() : main()).catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    // Every GIT_CONFIG* (a bare GIT_CONFIG redirects git config but not git push); the launcher deletes them.
    if (/^GIT_CONFIG/.test(key) && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
