import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { COMPANY_DELETE_BUSY, explainBlockedCompanyRemoval } from "../services/company-removal-conflict.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const NO_DATABASE = {} as Db;

describe("explainBlockedCompanyRemoval for lock contention", () => {
  it.each([
    ["a lock timeout", "55P03"],
    ["a deadlock", "40P01"],
  ])("turns %s into a 409 with the code company_delete_busy, wherever the driver puts the code", async (_label, code) => {
    for (const error of [{ code }, new Error("Failed query: delete from assets", { cause: { code } })]) {
      const explained = await explainBlockedCompanyRemoval(NO_DATABASE, COMPANY_ID, error);

      expect(explained).toBeInstanceOf(HttpError);
      expect(explained).toMatchObject({ status: 409, details: { code: COMPANY_DELETE_BUSY } });
      expect(explained?.message).toMatch(/Nothing was deleted/);
      expect(explained?.message).toMatch(/try again/i);
    }
    expect(COMPANY_DELETE_BUSY).toBe("company_delete_busy");
  });

  it("names no company, table or row", async () => {
    const explained = await explainBlockedCompanyRemoval(NO_DATABASE, COMPANY_ID, { code: "55P03", table_name: "assets" });

    const visible = JSON.stringify({ message: explained?.message, details: explained?.details });
    expect(visible).not.toContain(COMPANY_ID);
    expect(visible).not.toContain("assets");
  });

  it("leaves an error that is not lock contention or a foreign key refusal alone", async () => {
    expect(await explainBlockedCompanyRemoval(NO_DATABASE, COMPANY_ID, new Error("boom"))).toBeNull();
    expect(await explainBlockedCompanyRemoval(NO_DATABASE, COMPANY_ID, { code: "23505" })).toBeNull();
  });
});
