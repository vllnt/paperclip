import test from "node:test";
import assert from "node:assert/strict";
test("gate probe: this failure must turn the CI gate red", () => {
  assert.fail("intentional probe failure");
});
