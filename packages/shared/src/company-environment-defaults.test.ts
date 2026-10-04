import { describe, expect, it } from "vitest";
import { resolveCompanyEnvironmentDefault } from "./company-environment-defaults.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

describe("company execution defaults", () => {
  const settings = { defaultEnvironmentId: "worker-global", general: { companyEnvironmentDefaults: { alpha: "worker-alpha", beta: "worker-beta" } } };
  it("selects each company's own default from shared settings", () => {
    expect(resolveCompanyEnvironmentDefault(settings, "alpha")).toBe("worker-alpha");
    expect(resolveCompanyEnvironmentDefault(settings, "beta")).toBe("worker-beta");
  });
  it("preserves the instance default for companies without an override and legacy settings", () => {
    expect(resolveCompanyEnvironmentDefault(settings, "gamma")).toBe("worker-global");
    expect(resolveCompanyEnvironmentDefault({ defaultEnvironmentId: "legacy" }, "alpha")).toBe("legacy");
    expect(resolveCompanyEnvironmentDefault(undefined, "alpha")).toBeNull();
  });
  it("does not interpret inherited object properties as company settings", () => {
    expect(resolveCompanyEnvironmentDefault(settings, "toString")).toBe("worker-global");
  });
  it("validates company and environment identifiers before persistence", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ companyEnvironmentDefaults: { invalid: "invalid" } }).success).toBe(false);
    const defaults = { "11111111-1111-4111-8111-111111111111": "22222222-2222-4222-8222-222222222222" };
    expect(instanceGeneralSettingsSchema.parse({ companyEnvironmentDefaults: defaults }).companyEnvironmentDefaults).toEqual(defaults);
    expect(instanceGeneralSettingsSchema.parse({}).companyEnvironmentDefaults).toBeUndefined();
  });
});
