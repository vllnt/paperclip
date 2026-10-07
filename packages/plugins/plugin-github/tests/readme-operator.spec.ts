import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../src/manifest.js";

const VLLNT = "dc1d1a01-1c00-4a67-89f9-4efdde86c7ec";
const ANTHM = "2cae571f-5b44-4253-b73b-7700335a4ccf";
const PLUGIN = "vllnt.paperclip-github";
const BNT_OWNER = "bnt" + "vllnt";

/** The README's operator block, verbatim: the first sh fence after its heading. */
function operatorScript(): string {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const section = readme.slice(readme.indexOf("## Manage with the API/CLI"));
  const match = section.match(/```sh\n([\s\S]*?)```/);
  if (!match) throw new Error("README operator block is missing.");
  return match[1];
}

// Records each CLI call and answers like the Paperclip CLI with --json.
const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const company = option("-C");
const entry = { args };
if (args[0] === "secrets" && args[1] === "create") entry.secretValue = process.env[option("--value-env")] ?? null;
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + "\\n");
if (!process.env.PAPERCLIP_API_URL || !process.env.PAPERCLIP_API_KEY) { console.error("missing API env"); process.exit(1); }
if (args[0] === "secrets") console.log(JSON.stringify({ id: "secret-" + company, name: option("--name") }));
else if (args[0] === "plugin" && args[1] === "config") console.log(company === "${VLLNT}" ? JSON.stringify({ companyId: company, configJson: { personalLogin: "octo" } }) : "null");
else console.log("{}");
`;

describe("README operator sequence", () => {
  it("runs end to end for both companies with secret IDs only", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pgh-readme-"));
    try {
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "paperclipai"), stub);
      chmodSync(path.join(bin, "paperclipai"), 0o755);
      const pem = (name: string) => `-----BEGIN ${"PRIVATE"} KEY-----\n${name}\n-----END ${"PRIVATE"} KEY-----\n`;
      writeFileSync(path.join(dir, "v.pem"), pem("v-agents"));
      writeFileSync(path.join(dir, "a.pem"), pem("anthm-agents"));
      const log = path.join(dir, "calls.jsonl");
      execFileSync("bash", ["-euo", "pipefail", "-c", operatorScript()], {
        env: { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, PAPERCLIP_API_URL: "http://paperclip.test", PAPERCLIP_API_KEY: "board-key",
          V_AGENTS_PEM: path.join(dir, "v.pem"), ANTHM_AGENTS_PEM: path.join(dir, "a.pem") },
        stdio: "pipe",
      });
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; secretValue?: string });
      const option = (args: string[], name: string) => args[args.indexOf(name) + 1];
      const commands = calls.map(({ args }) => args[0] === "secrets" ? `secrets ${args[1]} ${option(args, "-C")}`
        : args[1] === "action" ? `action ${args[3]} ${option(args, "-C")}` : `${args[1]} ${option(args, "-C")}`);
      expect(commands).toEqual([
        `secrets create ${VLLNT}`, `secrets create ${ANTHM}`,
        `config ${VLLNT}`, `config:set ${VLLNT}`, `config ${ANTHM}`, `config:set ${ANTHM}`,
        `action company-app.connect ${VLLNT}`, `action company-app.connect ${ANTHM}`,
        `action allowed-owners.set ${VLLNT}`, `action allowed-owners.set ${ANTHM}`,
        `action company-app.status ${VLLNT}`, `action company-app.status ${ANTHM}`,
        `action repositories.list ${VLLNT}`, `action repositories.list ${ANTHM}`,
      ]);
      // Keys travel only through --value-env; command lines carry secret IDs.
      expect(calls.slice(0, 2).map(call => call.secretValue)).toEqual([pem("v-agents").trimEnd(), pem("anthm-agents").trimEnd()]);
      expect(JSON.stringify(calls.map(call => call.args))).not.toContain("PRIVATE KEY");
      const params = (index: number) => JSON.parse(option(calls[index].args, "--params-json"));
      const configs = [3, 5].map(index => JSON.parse(option(calls[index].args, "--payload-json")));
      expect(configs[0]).toEqual({ configJson: { personalLogin: "octo", appId: "5203754", appSlug: "v-agents", appName: "v-agents", privateKey: { type: "secret_ref", secretId: `secret-${VLLNT}`, version: "latest" } } });
      expect(configs[1]).toEqual({ configJson: { appId: "5203763", appSlug: "anthm-agents", appName: "anthm-agents", privateKey: { type: "secret_ref", secretId: `secret-${ANTHM}`, version: "latest" } } });
      for (const config of configs) {
        expect(Object.keys(config.configJson).every(key => key in (manifest.instanceConfigSchema!.properties as object))).toBe(true);
      }
      expect(calls.every(({ args }) => args[0] === "secrets" || args[2] === PLUGIN)).toBe(true);
      expect(params(6)).toEqual({ appId: "5203754", privateKeySecretId: `secret-${VLLNT}` });
      expect(params(7)).toEqual({ appId: "5203763", privateKeySecretId: `secret-${ANTHM}` });
      expect(params(8)).toEqual({ owners: ["vllnt", "maiaos", BNT_OWNER] });
      expect(params(9)).toEqual({ owners: ["Anthm-FR"] });
      expect(params(12)).toEqual({ refresh: true });
      expect(calls.every(({ args }) => args.includes("--json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
