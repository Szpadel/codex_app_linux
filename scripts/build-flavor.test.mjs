import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveArtifactName,
  getBuildFlavorDisplayName,
  getDesktopIdForBuildFlavor,
  parseBuildFlavor,
  resolveBuildFlavor,
} from "./build-flavor.mjs";

test("resolveBuildFlavor uses the upstream flavor when no local override is provided", () => {
  assert.deepEqual(resolveBuildFlavor({ upstreamBuildFlavor: "prod" }), {
    buildFlavor: "prod",
    upstreamBuildFlavor: "prod",
    hasOverride: false,
  });
});

test("resolveBuildFlavor prefers the CLI flag over the environment override", () => {
  assert.deepEqual(
    resolveBuildFlavor({
      cliBuildFlavor: "dev",
      envBuildFlavor: "agent",
      upstreamBuildFlavor: "prod",
    }),
    {
      buildFlavor: "dev",
      upstreamBuildFlavor: "prod",
      hasOverride: true,
    },
  );
});

test("parseBuildFlavor rejects unknown flavor names", () => {
  assert.throws(
    () => parseBuildFlavor("qa", { source: "--build-flavor" }),
    /Invalid --build-flavor: "qa"/,
  );
});

test("deriveArtifactName keeps the upstream artifact name when the selected flavor matches", () => {
  assert.equal(
    deriveArtifactName({
      version: "26.409.20454",
      buildFlavor: "prod",
      upstreamBuildFlavor: "prod",
    }),
    "Codex-26.409.20454-linux-x64.AppImage",
  );
});

test("deriveArtifactName appends the local flavor when overriding the upstream flavor", () => {
  assert.equal(
    deriveArtifactName({
      version: "26.409.20454",
      buildFlavor: "dev",
      upstreamBuildFlavor: "prod",
    }),
    "Codex-26.409.20454-linux-x64-dev.AppImage",
  );
});

test("build flavor metadata uses the same identity labels as the packaged app", () => {
  assert.equal(
    getBuildFlavorDisplayName({ productName: "Codex", buildFlavor: "dev" }),
    "Codex (Dev)",
  );
  assert.equal(getDesktopIdForBuildFlavor("dev"), "com.openai.codex.dev");
  assert.equal(
    getBuildFlavorDisplayName({ productName: "Codex", buildFlavor: "prod" }),
    "Codex",
  );
  assert.equal(getDesktopIdForBuildFlavor("prod"), "com.openai.codex");
});
