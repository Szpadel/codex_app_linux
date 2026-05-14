import assert from "node:assert/strict";
import test from "node:test";

import { isPackageCompatibleWithTarget } from "./native-modules.mjs";

test("isPackageCompatibleWithTarget accepts packages without platform restrictions", () => {
  assert.equal(isPackageCompatibleWithTarget({}), true);
});

test("isPackageCompatibleWithTarget rejects non-Linux packages", () => {
  assert.equal(isPackageCompatibleWithTarget({ os: ["darwin"] }), false);
});

test("isPackageCompatibleWithTarget honors npm negated platform rules", () => {
  assert.equal(isPackageCompatibleWithTarget({ os: ["!linux"] }), false);
  assert.equal(isPackageCompatibleWithTarget({ os: ["!darwin"] }), true);
});

test("isPackageCompatibleWithTarget rejects non-x64 packages", () => {
  assert.equal(isPackageCompatibleWithTarget({ cpu: ["arm64"] }), false);
});
