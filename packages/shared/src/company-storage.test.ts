import { describe, expect, it } from "vitest";
import { storageS3LocationSchema } from "./company-storage.js";

const location = (endpoint: string) => ({
  endpoint,
  region: "us-east-1",
  bucket: "acme-archive",
  prefix: "paperclip",
  forcePathStyle: false,
  encryption: { mode: "s3_managed" },
});

describe("storage location schema", () => {
  it("reports an endpoint the URL parser rejects as a validation issue instead of throwing", () => {
    const parsed = storageS3LocationSchema.safeParse(location("https://[fe80::1%25eth0]/"));
    expect(parsed.success).toBe(false);
  });

  it("accepts an HTTPS origin and refuses paths, queries and credentials", () => {
    expect(storageS3LocationSchema.safeParse(location("https://s3.eu-west-1.amazonaws.com/")).success).toBe(true);
    expect(storageS3LocationSchema.safeParse(location("https://s3.example.com/bucket")).success).toBe(false);
    expect(storageS3LocationSchema.safeParse(location("https://s3.example.com/?x=1")).success).toBe(false);
    expect(storageS3LocationSchema.safeParse(location("https://key:secret@s3.example.com/")).success).toBe(false);
  });
});
