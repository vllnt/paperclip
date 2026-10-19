import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkGitObjectForSigning, parseSshSigningKey, sshSign } from "../src/ssh-signature.js";

const keygen = (() => {
  try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; }
  catch (error: any) { return error?.code !== "ENOENT"; }
})();

describe("SSH commit signatures", () => {
  it.skipIf(!keygen)("signs with an OpenSSH ed25519 key so ssh-keygen verifies it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-openssh-key-"));
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "paperclip", "-f", path.join(dir, "key")]);
      const key = parseSshSigningKey(readFileSync(path.join(dir, "key"), "utf8"));
      const publicKey = readFileSync(path.join(dir, "key.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
      expect(key.publicKey).toBe(publicKey);
      expect(key.fingerprint).toBe(execFileSync("ssh-keygen", ["-l", "-f", path.join(dir, "key.pub")], { encoding: "utf8" }).split(" ")[1]);
      const message = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ncommitter a <b> 1 +0000\n\nx\n");
      writeFileSync(path.join(dir, "sig"), sshSign(key, message));
      writeFileSync(path.join(dir, "allowed"), `a ${publicKey}\n`);
      expect(execFileSync("ssh-keygen", ["-Y", "verify", "-f", path.join(dir, "allowed"), "-I", "a", "-n", "git", "-s", path.join(dir, "sig")], { input: message, encoding: "utf8" }))
        .toContain('Good "git" signature');
      // An encrypted key is refused without echoing it.
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret-pass", "-f", path.join(dir, "locked")]);
      expect(() => parseSshSigningKey(readFileSync(path.join(dir, "locked"), "utf8"))).toThrow(/unencrypted ed25519/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts only an exact commit object by the signer, written now, never a tag", () => {
    const now = Date.parse("2026-10-08T08:00:00Z"), seconds = now / 1000;
    const signer = { name: "B", email: "b@x" };
    const ident = (offset = 0) => `B <b@x> ${seconds + offset} +0100`;
    const check = (text: string) => checkGitObjectForSigning(Buffer.from(text), signer, now);
    // Only headers are parsed: a message may contain header-like lines.
    expect(check(`tree ${"a".repeat(40)}\nauthor ${ident(-60)}\ncommitter ${ident()}\n\nmsg\ncommitter C <c@x> 3 +0000\n`)).toEqual({ ok: true, kind: "commit" });
    expect(check(`tree ${"a".repeat(64)}\nparent ${"b".repeat(64)}\nauthor ${ident()}\ncommitter ${ident()}\n\n`)).toEqual({ ok: true, kind: "commit" });
    expect(check(`object ${"a".repeat(40)}\ntype commit\ntag v1\ntagger ${ident()}\n\nv1\n`)).toEqual({ ok: false, reason: "Paperclip signs commits only, not tags." });
    expect(check("blob\n\n")).toMatchObject({ ok: false, reason: expect.stringContaining("not a git commit") });
    expect(check(`tree ${"a".repeat(40)}\nauthor ${ident()}\ncommitter ${ident()}\ncommitter ${ident()}\n\n`)).toMatchObject({ ok: false, reason: expect.stringContaining("committer") });
    expect(check(`tree ${"a".repeat(40)}\nauthor C <c@x> ${seconds} +0000\ncommitter ${ident()}\n\n`)).toMatchObject({ ok: false, reason: expect.stringContaining("author is not B <b@x>") });
    expect(check(`tree ${"a".repeat(40)}\nauthor ${ident()}\ncommitter ${ident(-601)}\n\n`)).toMatchObject({ ok: false, reason: expect.stringContaining("committer time") });
    expect(() => parseSshSigningKey("not a key")).toThrow(/unencrypted ed25519/);
  });
});
