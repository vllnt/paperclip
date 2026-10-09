import { CreateMultipartUploadCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider, s3EncryptionParams } from "../storage/s3-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureSends() {
  const commands: unknown[] = [];
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) throw new Error("stop after create");
    if (command instanceof HeadObjectCommand) return { ContentLength: 1, ServerSideEncryption: "aws:kms", SSEKMSKeyId: "arn:aws:kms:us-east-1:111122223333:key/k1" } as never;
    return {} as never;
  });
  return commands;
}

describe("S3 provider encryption", () => {
  it("maps destination encryption modes to request parameters", () => {
    expect(s3EncryptionParams(undefined)).toEqual({});
    expect(s3EncryptionParams({ mode: "bucket_default" })).toEqual({});
    expect(s3EncryptionParams({ mode: "s3_managed" })).toEqual({ ServerSideEncryption: "AES256" });
    expect(s3EncryptionParams({ mode: "kms", kmsKeyId: "alias/archive" })).toEqual({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/archive" });
  });

  it("sends the encryption on single and multipart uploads and reports it on HEAD", async () => {
    const commands = captureSends();
    const provider = createS3StorageProvider({
      bucket: "acme-archive",
      region: "us-east-1",
      endpoint: "https://s3.example.com",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      requestHandler: { connectionTimeout: 5_000 },
      serverSideEncryption: { mode: "kms", kmsKeyId: "alias/archive" },
    });
    await provider.putObject({ objectKey: "a", body: Buffer.from("x"), contentType: "text/plain", contentLength: 1 });
    await expect(provider.putObject({ objectKey: "b", body: Buffer.alloc(0), contentType: "text/plain", contentLength: 17 * 1024 * 1024 }))
      .rejects.toThrow("stop after create");
    const head = await provider.headObject({ objectKey: "a" });
    const put = commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    const create = commands.find((command) => command instanceof CreateMultipartUploadCommand) as CreateMultipartUploadCommand;
    expect(put.input).toMatchObject({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/archive" });
    expect(create.input).toMatchObject({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/archive" });
    expect(head.serverSideEncryption).toBe("aws:kms");
    expect(head.serverSideEncryptionKeyId).toBe("arn:aws:kms:us-east-1:111122223333:key/k1");
  });

  it("sends a conditional write only when asked", async () => {
    const commands = captureSends();
    const provider = createS3StorageProvider({ bucket: "instance-bucket", region: "us-east-1" });
    await provider.putObject({ objectKey: "marker", body: Buffer.from("{}"), contentType: "application/json", contentLength: 2, ifNoneMatch: "*" });
    await provider.putObject({ objectKey: "plain", body: Buffer.from("x"), contentType: "text/plain", contentLength: 1 });
    const puts = commands.filter((command) => command instanceof PutObjectCommand) as PutObjectCommand[];
    expect(puts.map((put) => put.input.IfNoneMatch)).toEqual(["*", undefined]);
  });

  it("refuses a company client without its endpoint and network handler", () => {
    expect(() => createS3StorageProvider({
      bucket: "acme-archive",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    })).toThrow(/network policy handler/);
  });

  it("leaves instance storage requests unchanged", async () => {
    const commands = captureSends();
    const provider = createS3StorageProvider({ bucket: "instance-bucket", region: "us-east-1" });
    await provider.putObject({ objectKey: "a", body: Buffer.from("x"), contentType: "text/plain", contentLength: 1 });
    const put = commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).not.toHaveProperty("ServerSideEncryption");
  });
});
