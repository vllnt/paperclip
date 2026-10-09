import { ghCommandMayWrite, parseGhCommand } from "@paperclipai/shared";

/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
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
const MAX_REMOTE_REFS = 2000;
function remoteRefs(env, globalArgs, url) {
  const git = gitBinary();
  if (!git) return null;
  const { spawnSync } = require('node:child_process');
  const options = { env: { ...env, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  try {
    // Branches, tags and HEAD (with the branch it names): the patterns keep the many refs/pull/* of a busy repository out of the list.
    const listed = spawnSync(git, [...globalArgs, 'ls-remote', '--symref', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'], { ...options, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
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
    const present = spawnSync(git, [...globalArgs, 'cat-file', '--batch-check'], { ...options, timeout: 10000, input: [...shas].join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'] });
    if (present.error || present.status !== 0) return null;
    const tips = present.stdout.split('\n').map(line => line.split(' ')).filter(parts => parts[1] === 'commit' || parts[1] === 'tag').map(parts => parts[0]);
    return { tips, heads, defaultTip };
  } catch { return null; }
}
// A push that runs with a credential goes to one URL and sends one list of refs, both fixed before it starts, and it
// runs in a git directory of its own: config that this launcher writes (that URL, no push settings, no hooks), a copy of
// the refs it names, and the checkout's objects as an alternate. What the checkout's config, hooks, remote names,
// refspecs and environment say after the check cannot reach it. A push that cannot be reduced to that is refused.
const PUSH_SHORT = { f: '--force', n: '--dry-run', q: '--quiet', v: '--verbose', u: '--set-upstream', d: '--delete', 4: '--ipv4', 6: '--ipv6' };
const PUSH_LONG = ['--force', '--dry-run', '--quiet', '--verbose', '--progress', '--no-progress', '--porcelain', '--atomic', '--no-atomic', '--thin', '--no-thin',
  '--force-if-includes', '--no-force-if-includes', '--delete', '--set-upstream', '--ipv4', '--ipv6', '--no-force-with-lease'];
// The sealed push does these itself, whatever was asked.
const PUSH_FORCED = ['--no-verify', '--verify', '--no-follow-tags', '--no-recurse-submodules'];
// The options a sealed push forwards, and its arguments; a problem names what cannot be reduced (--all, --mirror, --tags,
// --follow-tags, --prune, --signed, --receive-pack and any option not listed).
function sealedOptions(pushArgs) {
  const flags = [], rest = [];
  let upstream = false;
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
      if (name === '--force-with-lease' || (PUSH_LONG.includes(name) && attached === undefined)) {
        flags.push(arg);
        if (name === '--set-upstream') upstream = true;
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
      if (!PUSH_SHORT[arg[i]]) return { problem: 'the option -' + arg[i] + ' sends refs that cannot be listed' };
      flags.push(PUSH_SHORT[arg[i]]);
      if (arg[i] === 'u') upstream = true;
    }
  }
  return { flags, rest, upstream };
}
// A sealed push's whole environment: nothing of the checkout's own steering (GIT_DIR, GIT_EXEC_PATH, GIT_TRACE*, GIT_SSH,
// object and index paths…) is carried over, only what a credentialed command needs.
const SEALED_ENV = /^(LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|SYSTEMROOT|COMSPEC|GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GH_HOST|GH_CONFIG_DIR|GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_SSH_COMMAND|SSH_AUTH_SOCK)$/;
function sealedEnv(env, home, gitDir) {
  const sealed = {};
  for (const [key, value] of Object.entries(env)) if (SEALED_ENV.test(key) && typeof value === 'string') sealed[key] = value;
  return { ...sealed, PATH: originalPath.join(path.delimiter), HOME: home, GIT_DIR: gitDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}
const MAX_SEALED_REFS = 20000;
// The command, environment and private git directory of the sealed push, or { problem }. authorized is the report that the
// broker answered with a credential: the sealed push must send exactly what it described, to the one URL it listed.
function sealedPush(env, globalArgs, pushArgs, authorized, scratch) {
  const options = sealedOptions(pushArgs);
  if (options.problem) return { problem: options.problem };
  const git = gitBinary();
  if (!git || !scratch) return { problem: 'its private git directory cannot be made' };
  const { positional, repoOption } = gitNetworkArgs('push', pushArgs);
  if (JSON.stringify(positional) !== JSON.stringify(options.rest)) return { problem: 'its arguments cannot be read the way git reads them' };
  const branch = gitOutput(env, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const where = pushTarget(env, globalArgs, positional, repoOption, branch ? branch.trim() : '', (key, type) => gitConfigValue(env, globalArgs, key, type) || '');
  const url = where.allUrls.length === 1 ? where.allUrls[0] : '';
  const reported = authorized.pushUrls || [];
  if (!url || /[\x00-\x1f]/.test(url) || reported.length !== 1 || reported[0] !== url) return { problem: 'it does not go to exactly one destination that the broker was told' };
  // Repository config (push.default, a remote's push refspecs or mirror) decides which refs a push without refspecs sends.
  if (authorized.implicitPush) return { problem: 'repository configuration decides which refs it sends' };
  const name = where.configured.length ? where.target : null;
  // Without refspecs git pushes the current branch (the broker was told so: it saw HEAD), and a deletion names its refs.
  const specs = positional.length > 1 || options.flags.includes('--delete') ? positional.slice(1) : ['HEAD'];
  const { spawnSync } = require('node:child_process');
  try {
    const root = fs.mkdtempSync(path.join(scratch, 'push-'));
    const gitDir = path.join(root, 'git'), hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    const sealed = sealedEnv(env, root, gitDir);
    const run = args => spawnSync(git, args, { env: sealed, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'] }).status === 0;
    const format = (gitOutput(env, globalArgs, ['rev-parse', '--show-object-format']) || 'sha1').trim();
    if (!/^sha(1|256)$/.test(format) || !run(['init', '-q', '--bare', '--template=', '--object-format=' + format])) return { problem: 'its private git directory cannot be made' };
    const config = path.join(gitDir, 'config');
    const set = (key, value) => run(['config', '--file', config, key, value]);
    if (!set('core.hooksPath', hooks)) return { problem: 'its private git directory cannot be made' };
    if (name && !(set('remote.' + name + '.url', url) && set('remote.' + name + '.fetch', '+refs/heads/*:refs/remotes/' + name + '/*'))) return { problem: 'its private git directory cannot be made' };
    // The checkout's objects, and its shallow boundary (what a push of a shallow checkout leaves out).
    const place = what => (gitOutput(env, globalArgs, ['rev-parse', '--path-format=absolute', '--git-path', what]) || '').trim();
    const objects = place('objects');
    if (!objects) return { problem: 'the objects of this checkout cannot be located' };
    const more = (env.GIT_ALTERNATE_OBJECT_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir));
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), [objects, ...more].join('\n') + '\n');
    const shallow = place('shallow');
    if (shallow && fs.existsSync(shallow)) fs.copyFileSync(shallow, path.join(gitDir, 'shallow'));
    // The refs the push can name, as they are now: HEAD, branches, tags and the destination's remote-tracking refs.
    const listed = gitOutput(env, globalArgs, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', ...(name ? ['refs/remotes/' + name] : [])]);
    if (listed === null) return { problem: 'the refs of this checkout cannot be read in full' };
    const lines = listed.split('\n').filter(Boolean);
    if (lines.length > MAX_SEALED_REFS) return { problem: 'this checkout has too many refs to copy' };
    const tracking = new Map();
    for (const line of lines) {
      const match = /^([0-9a-f]{40,64}) (refs\/(?:heads|tags|remotes)\/\S+)$/.exec(line);
      if (!match || match[2].split('/').some(part => part === '' || part === '.' || part === '..')) return { problem: 'a ref of this checkout cannot be copied' };
      fs.mkdirSync(path.dirname(path.join(gitDir, match[2])), { recursive: true });
      fs.writeFileSync(path.join(gitDir, match[2]), match[1] + '\n');
      if (name && match[2].startsWith('refs/remotes/')) tracking.set(match[2], match[1]);
    }
    const head = gitOutput(env, globalArgs, ['symbolic-ref', '-q', 'HEAD']);
    const detached = (gitOutput(env, globalArgs, ['rev-parse', '--verify', '-q', 'HEAD']) || '').trim();
    if (!head && !detached) return { problem: 'HEAD of this checkout cannot be read' };
    fs.writeFileSync(path.join(gitDir, 'HEAD'), (head ? 'ref: ' + head.trim() : detached) + '\n');
    // The push as the private directory will run it must be the push the broker was told about: same commits, refs and branch.
    const target = name || url;
    const view = pushReport(sealed, [], [...options.flags, '--', target, ...specs], 'unknown');
    const same = ['shas', 'refs', 'currentBranch'].every(key => JSON.stringify(view[key] === undefined ? null : view[key]) === JSON.stringify(authorized[key] === undefined ? null : authorized[key]));
    if (!same || JSON.stringify(view.pushUrls) !== JSON.stringify([url])) return { problem: 'the refs it names are not the ones that the broker was told' };
    return {
      args: ['-c', 'core.hooksPath=' + hooks, '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'protocol.ext.allow=never',
        'push', ...options.flags, '--no-verify', '--no-follow-tags', '--no-recurse-submodules', '--', target, ...specs],
      env: sealed, gitDir, name, tracking, upstream: options.upstream,
    };
  } catch { return { problem: 'its private git directory cannot be made' }; }
}
// What git does for a push to a configured remote, done in the checkout after the sealed push: the remote-tracking refs
// the push moved, and the upstream that -u records.
function sealedSync(env, globalArgs, plan) {
  try {
    if (plan.name) {
      const out = gitOutput(plan.env, [], ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/' + plan.name + '/']) || '';
      const now = new Map();
      for (const line of out.split('\n')) { const at = line.lastIndexOf(' '); if (at > 0) now.set(line.slice(0, at), line.slice(at + 1)); }
      let commands = '';
      for (const [ref, sha] of now) if (plan.tracking.get(ref) !== sha) commands += 'update ' + ref + ' ' + sha + '\n';
      for (const ref of plan.tracking.keys()) if (!now.has(ref)) commands += 'delete ' + ref + '\n';
      if (commands) gitRun(env, globalArgs, ['update-ref', '--stdin'], commands);
    }
    if (plan.upstream) {
      const recorded = gitOutput(plan.env, [], ['config', '--file', path.join(plan.gitDir, 'config'), '--get-regexp', '^branch\\..*\\.(remote|merge)$']) || '';
      for (const line of recorded.split('\n')) { const at = line.indexOf(' '); if (at > 0) gitRun(env, globalArgs, ['config', line.slice(0, at), line.slice(at + 1)]); }
    }
  } catch {}
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
  // authorized: the report of the command that the broker last answered with a credential.
  let attribution = null, credentialed = false, report = null, authorized = null;
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
      appendGitConfig(env, 'http.sslVerify', 'true');
      appendGitConfig(env, 'http.proxy', '');
      for (const key of Object.keys(env)) {
        if (/^(https?_proxy|all_proxy|git_ssl_no_verify|git_ssl_cainfo|git_ssl_capath|git_ssl_cert|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs|curl_ca_bundle|requests_ca_bundle|git_proxy_command|git_trace_curl|git_curl_verbose|git_trace_redact)$/i.test(key)) delete env[key];
      }
      if (program === 'git' && gitTrustProblem(env, report)) {
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
      const known = report.pushUrls && report.pushUrls.length === 1 ? remoteRefs(env, argv.slice(0, at), report.pushUrls[0]) : null;
      const checked = operation(env, known || 'unknown');
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
  let gitAt = 0;
  if (program === 'git') while (gitAt < argv.length && argv[gitAt].startsWith('-')) gitAt += GIT_GLOBAL_WITH_VALUE.includes(argv[gitAt]) ? 2 : 1;
  const gitSubcommand = program === 'git' ? argv[gitAt] : undefined;
  if (credentialed && authorized && ['push', 'fetch', 'pull', 'ls-remote'].includes(gitSubcommand)) {
    const now = operation(env, 'unknown');
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
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const scratch = configReady ? configDirectory : null;
  const args = attribution ? attributedArgs(argv, attribution, scratch) : argv;
  // A push that holds a credential runs sealed (see sealedPush): one URL, one list of refs, a git directory of its own, no
  // hooks, and an environment that carries nothing of the checkout's steering.
  let sealedPlan = null;
  if (credentialed && authorized && gitSubcommand === 'push') {
    sealedPlan = sealedPush(env, argv.slice(0, gitAt), argv.slice(gitAt + 1), authorized, scratch);
    if (sealedPlan.problem) {
      process.stderr.write('Paperclip: this push cannot run with a GitHub credential, because ' + sealedPlan.problem + '. Push one branch to one remote (git push <remote> <branch>) without other options.\n');
      process.exit(1);
    }
  }
  let child = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child && child.kill(signal));
  const run = (args, captureStderr, childEnv = env) => new Promise(resolve => {
    let stderr = '', settled = false;
    const settle = (code) => { if (!settled) { settled = true; resolve({ code, stderr }); } };
    child = spawn(executable, args, { env: childEnv, stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'] });
    if (captureStderr) child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); settle(1); });
    // A captured stderr is complete only once the pipe closes.
    child.once(captureStderr ? 'close' : 'exit', (code) => settle(code === null ? 128 : code));
  });
  const reviewing = program === 'gh' && args[0] === 'pr' && args[1] === 'review' && args.some(arg => SELF_REVIEW_VERDICTS[arg]);
  let result = sealedPlan ? await run(sealedPlan.args, false, sealedPlan.env) : await run(args, reviewing);
  if (sealedPlan) sealedSync(env, argv.slice(0, gitAt), sealedPlan);
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
