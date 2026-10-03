"""Reject private infrastructure literals in new fork commits; never print matches."""
import re
import subprocess
import sys

BASE = "8f8a0ab7effbd6a0584107d8038736c134ee5047"
PATTERNS = {
    "private DNS name": re.compile(r"(?i)\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b"),
    "private IPv4 address": re.compile(r"(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.])"),
    "private key": re.compile(r"-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----"),
    "operator filesystem path": re.compile(r"/(?:Users|home)/[a-z][a-z0-9_-]+/(?:\.ssh|\.local|Github)"),
}

def violations(lines):
    return sorted({label for line in lines for label, pattern in PATTERNS.items() if pattern.search(line)})

def main():
    end = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    subprocess.run(["git", "merge-base", "--is-ancestor", BASE, end], check=True)
    patch = subprocess.check_output(["git", "log", "--format=", "-p", "--diff-filter=AM", BASE + ".." + end], text=True)
    added = [line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")]
    found = violations(added)
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
