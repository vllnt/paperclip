"""Record a completed immutable image build; no deployment credentials required."""
import json
import os
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
commit = os.environ["BUILT_SOURCE_COMMIT"]
digest = os.environ["BUILT_IMAGE_DIGEST"]
assert re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid source commit"
assert re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "Invalid image digest"
image = "ghcr.io/vllnt/paperclip@" + digest
template = (root / "deploy/compose.template.yaml").read_text()
assert template.count("IMAGE_REFERENCE") == 1
(root / "deploy/compose.yaml").write_text(template.replace("IMAGE_REFERENCE", image))
(root / "deploy/release.json").write_text(json.dumps({"source_commit": commit, "image": image}, indent=2) + "\n")
