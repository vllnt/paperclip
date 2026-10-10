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
// status is null when git could not run, timed out or wrote more than 4 MiB.
function gitRun(env, globalArgs, args) {
  const git = gitBinary();
  if (!git) return { status: null, stdout: '' };
  try {
    const result = require('node:child_process').spawnSync(git, [...globalArgs, ...args],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: result.error ? null : result.status, stdout: result.stdout || '' };
  } catch { return { status: null, stdout: '' }; }
}
function appendGitConfig(env, key, value) {
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  env['GIT_CONFIG_KEY_' + count] = key; env['GIT_CONFIG_VALUE_' + count] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}
function gitOutput(env, globalArgs, args) {
  const result = gitRun(env, globalArgs, args);
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
// What a push sends: the checked-out branch, full names of bare refspec names,
// the commits, and whether new commits change workflow files.
function pushReport(env, globalArgs, pushArgs) {
  const { positional, repoOption, deleting } = gitNetworkArgs('push', pushArgs);
  const branch = gitOutput(env, globalArgs, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = branch ? branch.trim() : '';
  let unknown = false;
  const config = (key, type) => { const value = gitConfigValue(env, globalArgs, key, type); if (value === null) unknown = true; return value || ''; };
  // Booleans as git reads them (yes, on, 1 and true are all true); an invalid one is unknown, so it counts as set.
  const followTags = config('push.followTags', 'bool') === 'true';
  // The remote git pushes to: the argument, --repo, then branch and repository config.
  const target = positional[0] || repoOption
    || (current && config('branch.' + current + '.pushRemote'))
    || config('remote.pushDefault')
    || (current && config('branch.' + current + '.remote'))
    || 'origin';
  // A configured remote name first (as git does); otherwise the target is itself a URL or path.
  const configured = !target.includes(':') && REMOTE_NAME.test(target)
    ? (gitOutput(env, globalArgs, ['remote', 'get-url', '--push', '--all', target]) || '').split('\n').map(url => url.trim()).filter(Boolean) : [];
  const allUrls = configured.length ? configured : /[:/]/.test(target) ? [target.slice(0, 1000)] : [];
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
  if (commits.length && shas.length === commits.length) {
    // Unquoted names (non-ASCII too) and merge commits' own changes against their first parent.
    const files = gitOutput(env, ['-c', 'core.quotePath=false', ...globalArgs], ['log', '--format=', '--name-only', '--diff-merges=first-parent', ...shas, '--not', '--remotes']);
    if (files !== null) touchesWorkflows = files.split('\n').some(file => file.startsWith('.github/workflows/'));
  }
  return { currentBranch: current || null, refs, shas, touchesWorkflows, pushUrls, ...(implicitPush ? { implicitPush: true } : {}), ...(followTags || unknown ? { followTags: true } : {}),
    ...(recursion === 'no' || recursion === 'check' ? {} : { recurseSubmodules: recursion === null ? 'unknown' : recursion.slice(0, 100) }), ...(cut ? { truncated: true } : {}) };
}
function operation(env) {
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
    if (argv[index] === 'push') extra = pushReport(env, globalArgs, argv.slice(index + 1));
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
  // A busy server (409: the run bridge says so when its own 10 s timeout
  // fires) and a request that timed out (this launcher's own 10 s limit) are
  // retried with a growing, jittered pause: 1, 2, 4 and 8 s at most, five
  // tries in all. The first request may still be running on the server, so
  // asking every second would only add work to a server that is already
  // busy. Other transport failures keep a small budget of their own, and the
  // body is read inside the retry so a failed read is retried too. A failure
  // on a route that is not the last moves on to the next route at once; only
  // the last route spends a budget. When the tries run out, the error says why.
  const BACKOFF_MS = [1000, 2000, 4000, 8000], TRIES = BACKOFF_MS.length + 1;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const startedAt = Date.now();
  let transportFailures = 0, slowTries = 0, index = 0, response, result;
  // One busy or timed-out request: count it, give up when the tries are spent, else pause (none when moving to another route).
  const slowTry = (reason, wait) => {
    slowTries += 1;
    if (slowTries >= TRIES) {
      const error = new Error('credentials unavailable after ' + slowTries + ' tries over ' + Math.round((Date.now() - startedAt) / 1000) + ' s: ' + reason);
      error.diagnostic = error.message;
      throw error;
    }
    return wait ? pause(Math.round(BACKOFF_MS[slowTries - 1] * (0.5 + Math.random() / 2))) : undefined;
  };
  for (;;) {
    try {
      response = await fetch(urls[index], {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
          'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
        body,
      });
      if (response.status === 409) {
        await response.arrayBuffer();
        await slowTry('the Paperclip server is busy (HTTP 409)', true);
        continue;
      }
      // A failed read of a successful answer is retried; an error answer is read best-effort.
      result = response.ok ? await response.json() : await response.json().catch(() => null);
      return { response, result };
    } catch (error) {
      if (error && error.diagnostic) throw error;
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (index < urls.length - 1) {
        if (timedOut) slowTry('the Paperclip server did not answer within 10 s', false);
        index += 1;
        continue;
      }
      if (timedOut) {
        await slowTry('the Paperclip server did not answer within 10 s', true);
        continue;
      }
      transportFailures += 1;
      if (transportFailures >= 3) throw error;
      await pause(500 * transportFailures);
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
  // Why the broker could not be asked (set after the tries are spent): said again if the command then fails.
  let brokerFailure = null;
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
  let attribution = null, credentialed = false, report = null;
  {
    for (const key of Object.keys(env)) {
      // CODESPACES makes gh send GITHUB_TOKEN to non-github.com hosts. A bare GIT_CONFIG redirects
      // git config (what the report reads) but not git push, so every GIT_CONFIG* goes.
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*|GH_HOST|CODESPACES)$/.test(key)) delete env[key];
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
    });
    let answered = null;
    try {
      report = operation(env);
      answered = await brokerPost(env, '/runtime-tools/github/credentials', JSON.stringify({ operation: report }));
      if (!answered) diagnostic('capability_missing');
    } catch (error) {
      // After the tries are spent the error says why. It is said again below if the command then fails: git alone
      // would only say that it could not read a username.
      brokerFailure = error && error.diagnostic ? error.diagnostic : 'broker_transport_unavailable';
      diagnostic(brokerFailure);
    }
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
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
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
    if (program === 'gh' && !credentialed && ghNamesOtherHost(argv)) {
      process.stderr.write('Paperclip: this gh command names a host other than github.com; it does not run with any other GitHub credential.\n');
      process.exit(1);
    }
    if (program === 'gh' && !credentialed && ghMayWrite(argv)) {
      process.stderr.write('Paperclip: no managed GitHub credential for this gh command, which may write; it does not run with any other GitHub credential.\n');
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
  let child = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child && child.kill(signal));
  const run = (args, captureStderr) => new Promise(resolve => {
    let stderr = '', settled = false;
    const settle = (code) => { if (!settled) { settled = true; resolve({ code, stderr }); } };
    child = spawn(executable, args, { env, stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'] });
    if (captureStderr) child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); settle(1); });
    // A captured stderr is complete only once the pipe closes.
    child.once(captureStderr ? 'close' : 'exit', (code) => settle(code === null ? 128 : code));
  });
  const reviewing = program === 'gh' && args[0] === 'pr' && args[1] === 'review' && args.some(arg => SELF_REVIEW_VERDICTS[arg]);
  let result = await run(args, reviewing);
  if (reviewing && result.code !== 0 && /own pull request/i.test(result.stderr)) {
    const fallback = selfReviewFallbackArgs(args, scratch);
    if (fallback) {
      process.stderr.write('Paperclip: GitHub does not allow this verdict on your own pull request; posting it as a comment review.\n');
      result = await run(fallback, false);
    }
  }
  if (brokerFailure && result.code !== 0) process.stderr.write('Paperclip: this command ran without managed GitHub credentials (' + brokerFailure + ').\n');
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
