"""Reject private infrastructure literals in new fork commits; never print matches."""
import re
import subprocess
import sys

BASE = "1c07b5903b1b11139b1e1ce052a3cd4885865d90"
PATTERNS = {
    "private DNS name": re.compile(r"(?i)\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b"),
    "private IPv4 address": re.compile(r"(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.])"),
    "private key": re.compile(r"-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----"),
    "operator filesystem path": re.compile(r"/(?:Users|home)/[a-z][a-z0-9_-]+/(?:\.ssh|\.local|Github)"),
}
# Commits already published to main that the guard cannot remove from history
# (main rejects force pushes). Each entry must also remove the value from the
# current tree in a later commit. Never add a commit that has not been published.
PUBLISHED_EXCEPTIONS = frozenset({
    # Tailnet gateway host mapping in deploy/compose*.yaml; replaced by
    # PAPERCLIP_AI_GATEWAY_HOST and PAPERCLIP_AI_GATEWAY_HOST_IP.
    "6e3d56d8f52a0a9e9cc00978e394e7c253c02c2a",
})
COMMIT_MARKER = "\0commit "

def violations(lines):
    return sorted({label for line in lines for label, pattern in PATTERNS.items() if pattern.search(line)})

def added_lines(log_output, exceptions=PUBLISHED_EXCEPTIONS):
    """Return lines added by commits in `git log --format=%x00commit %H -p` output, skipping exceptions."""
    added, skip = [], False
    for line in log_output.splitlines():
        if line.startswith(COMMIT_MARKER):
            skip = line[len(COMMIT_MARKER):].strip() in exceptions
        elif not skip and line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    return added

def main():
    end = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    subprocess.run(["git", "merge-base", "--is-ancestor", BASE, end], check=True)
    patch = subprocess.check_output(["git", "log", "--format=%x00commit %H", "-p", "--diff-filter=AM", BASE + ".." + end], text=True)
    found = violations(added_lines(patch))
    names = subprocess.check_output(["git", "diff", "--name-only", BASE, end], text=True).splitlines()
    if any(re.search(r"(?:^|/)\.env(?:$|\.(?!example$|sample$|template$))", name) for name in names):
        found.append("runtime environment file")
    if found:
        print("Public configuration check failed: " + ", ".join(found), file=sys.stderr)
        return 1
    print("Public configuration check passed.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
