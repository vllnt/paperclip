import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageS3Location } from "@paperclipai/shared";
import { companyS3Lookup, storageEndpointPolicy } from "../storage/company-s3-network.js";

const location: StorageS3Location = {
  endpoint: "https://s3.example.com/",
  region: "us-east-1",
  bucket: "acme-archive",
  prefix: "",
  forcePathStyle: false,
  encryption: { mode: "s3_managed" },
};

function resolveWith(lookup: LookupFunction, hostname: string) {
  return new Promise<string>((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address) => (error ? reject(error) : resolve(address as string)));
  });
}

/** DNS answers in order; the last one repeats. */
function answers(...addresses: string[]) {
  let call = 0;
  return async () => {
    const address = addresses[Math.min(call, addresses.length - 1)]!;
    call += 1;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

afterEach(() => {
  delete process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS;
});

describe("company S3 endpoint policy", () => {
  it("requires HTTPS unless the exact origin is allowlisted", () => {
    expect(() => storageEndpointPolicy({ endpoint: "http://s3.example.com/" })).toThrow(/HTTPS/);
    process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = "http://minio.internal:9000";
    expect(storageEndpointPolicy({ endpoint: "http://minio.internal:9000/" }).allowPrivateNetwork).toBe(true);
    expect(() => storageEndpointPolicy({ endpoint: "http://minio.internal:9001/" })).toThrow(/HTTPS/);
  });
});

describe("company S3 socket lookup", () => {
  it("resolves only the destination's own host names to public addresses", async () => {
    const lookup = await companyS3Lookup(location, { lookup: answers("93.184.216.34") });
    await expect(resolveWith(lookup, "acme-archive.s3.example.com")).resolves.toBe("93.184.216.34");
    await expect(resolveWith(lookup, "s3.example.com")).resolves.toBe("93.184.216.34");
    await expect(resolveWith(lookup, "other.example.com")).rejects.toMatchObject({ status: 422 });
  });

  it("refuses a host that answers with a private address at connect time (DNS rebinding)", async () => {
    // The endpoint check sees a public address; the socket lookup then gets a private one.
    const lookup = await companyS3Lookup(location, { lookup: answers("93.184.216.34", "127.0.0.7") });
    await expect(resolveWith(lookup, "acme-archive.s3.example.com")).rejects.toMatchObject({ status: 422 });
  });

  it("refuses private and metadata IP literals, and metadata even when allowlisted", async () => {
    await expect(companyS3Lookup({ ...location, endpoint: "https://127.1.2.3/" })).rejects.toMatchObject({ status: 422 });
    await expect(companyS3Lookup({ ...location, endpoint: "https://[fd00::1]/" })).rejects.toMatchObject({ status: 422 });
    process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = "http://169.254.169.254";
    await expect(companyS3Lookup({ ...location, endpoint: "http://169.254.169.254/" })).rejects.toMatchObject({ status: 422 });
  });

  it("allows private addresses for an allowlisted origin", async () => {
    process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = "http://minio.internal:9000";
    const lookup = await companyS3Lookup(
      { ...location, endpoint: "http://minio.internal:9000/", forcePathStyle: true },
      { lookup: answers("127.0.0.7") },
    );
    await expect(resolveWith(lookup, "minio.internal")).resolves.toBe("127.0.0.7");
    // Path style: the bucket host name is not a valid target.
    await expect(resolveWith(lookup, "acme-archive.minio.internal")).rejects.toMatchObject({ status: 422 });
  });
});
