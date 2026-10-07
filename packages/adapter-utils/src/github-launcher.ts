/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
// Agents may act as a person's GitHub account. Their commits and PR text are
// marked so that person can tell agent work from their own; the GitHub actor
// itself is unchanged.
const GIT_OPTIONS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'];
function gitSubcommandIndex(args) {
  for (let index = 0; index < args.length; index++) {
    if (GIT_OPTIONS_WITH_VALUE.includes(args[index])) index++;
    else if (!args[index].startsWith('-')) return index;
  }
  return -1;
}
// git commit --trailer needs Git 2.32. Older Git keeps working, unmarked.
function gitSupportsTrailers(env) {
  try {
    const version = /(\d+)\.(\d+)/.exec(execFileSync(executable, ['--version'], { encoding: 'utf8', env }));
    return Boolean(version) && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 32));
  } catch { return false; }
}
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
function attributedArgs(args, attribution, env, scratch) {
  const signature = 'Paperclip agent ' + attribution.agentName + ' (run ' + attribution.runId + ')';
  if (program === 'git') {
    const index = gitSubcommandIndex(args);
    if (index < 0 || args[index] !== 'commit' || !gitSupportsTrailers(env)) return args;
    return [...args.slice(0, index), '-c', 'trailer.ifexists=addIfDifferent', 'commit',
      '--trailer', 'Paperclip-Agent: ' + attribution.agentName + ' (run ' + attribution.runId + ')', ...args.slice(index + 1)];
  }
  if (!(GH_BODY_COMMANDS[args[0]] || []).includes(args[1])) return args;
  const footer = '_Posted by ' + signature + '._';
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
  const prefix = '**Review verdict: ' + verdict + '.** GitHub does not let a pull request author ' + verdict
    + ' on their own pull request, so this verdict is posted as a comment review.';
  return rewriteGhBody([...args.filter(arg => arg !== flag), '--comment'],
    body => body.trim() ? prefix + '\n\n' + body : prefix, true, scratch);
}
async function main() {
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
  let attribution = null;
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
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
    // A bridged sandbox reaches Paperclip only through its callback bridge
    // (PAPERCLIP_API_URL); the server's public broker URL may not even resolve
    // there. Other runs keep the broker URL first. A transport failure moves on
    // to the other route; HTTP answers, including a rejected capability, never do.
    const routes = env.PAPERCLIP_API_BRIDGE_MODE
      ? [env.PAPERCLIP_API_URL, env.PAPERCLIP_GITHUB_BROKER_URL]
      : [env.PAPERCLIP_GITHUB_BROKER_URL, env.PAPERCLIP_API_URL];
    const urls = [...new Set(routes.filter(Boolean)
      .map(base => base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials'))];
    try {
    let response;
    if (urls.length && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      // Only the last route spends the transport budget.
      let transportFailures = 0, conflicts = 0, route = 0, result;
      for (;;) {
        try {
          response = await fetch(urls[route], {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status === 409 && conflicts < 29) {
            conflicts += 1;
            await response.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          result = response.ok ? await response.json() : null;
          break;
        } catch (error) {
          if (route < urls.length - 1) { route += 1; continue; }
          transportFailures += 1;
          if (transportFailures >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * transportFailures));
        }
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) : '';
      if (result.attribution && clean(result.attribution.agentName) && clean(result.attribution.runId)) {
        attribution = { agentName: clean(result.attribution.agentName), runId: clean(result.attribution.runId) };
      }
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
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
  const args = attribution ? attributedArgs(process.argv.slice(2), attribution, env, scratch) : process.argv.slice(2);
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
  process.exitCode = result.code;
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
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
