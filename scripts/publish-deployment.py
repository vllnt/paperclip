"""Publish the two image records as a GitHub-signed, compare-and-swap commit."""
import base64
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
repo = os.environ["GITHUB_REPOSITORY"]
expected = os.environ["BUILT_SOURCE_COMMIT"]
head = subprocess.check_output(["gh", "api", "repos/" + repo + "/git/ref/heads/main", "--jq", ".object.sha"], text=True).strip()
if head != expected:
    print("Newer source revision exists; leave deployment to its build.")
    raise SystemExit(0)
files = [{"path": name, "contents": base64.b64encode((root / name).read_bytes()).decode()} for name in ["deploy/compose.yaml", "deploy/release.json"]]
query = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }"
payload = {"query": query, "variables": {"input": {"branch": {"repositoryNameWithOwner": repo, "branchName": "main"}, "expectedHeadOid": expected, "message": {"headline": "Deploy completed source build"}, "fileChanges": {"additions": files}}}}
result = subprocess.run(["gh", "api", "graphql", "--input", "-"], input=json.dumps(payload), text=True, capture_output=True, check=True)
data = json.loads(result.stdout)
if data.get("errors"):
    raise RuntimeError("Deployment record rejected; inspect the repository rules and head revision")
print("Published GitHub-signed deployment commit " + data["data"]["createCommitOnBranch"]["commit"]["oid"])
