export const BUILD_FLAVORS = Object.freeze([
  "dev",
  "agent",
  "nightly",
  "internal-alpha",
  "public-beta",
  "prod",
]);

const DISPLAY_LABELS = Object.freeze({
  dev: "Dev",
  agent: "Agent",
  nightly: "Nightly",
  "internal-alpha": "Alpha",
  "public-beta": "Beta",
  prod: null,
});

const DESKTOP_IDS = Object.freeze({
  dev: "com.openai.codex.dev",
  agent: "com.openai.codex.agent",
  nightly: "com.openai.codex.nightly",
  "internal-alpha": "com.openai.codex.alpha",
  "public-beta": "com.openai.codex.beta",
  prod: "com.openai.codex",
});

function formatExpectedFlavors() {
  return BUILD_FLAVORS.join(", ");
}

export function parseBuildFlavor(value, { source = "build flavor" } = {}) {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  if (!BUILD_FLAVORS.includes(normalized)) {
    throw new Error(`Invalid ${source}: "${value}". Expected one of: ${formatExpectedFlavors()}`);
  }

  return normalized;
}

export function resolveBuildFlavor({
  cliBuildFlavor,
  envBuildFlavor = process.env.CODEX_BUILD_FLAVOR,
  upstreamBuildFlavor,
} = {}) {
  const resolvedUpstreamBuildFlavor =
    parseBuildFlavor(upstreamBuildFlavor, { source: "upstream build flavor" }) ?? "prod";
  const selectedOverride =
    parseBuildFlavor(cliBuildFlavor, { source: "--build-flavor" }) ??
    parseBuildFlavor(envBuildFlavor, { source: "CODEX_BUILD_FLAVOR" });

  return {
    buildFlavor: selectedOverride ?? resolvedUpstreamBuildFlavor,
    upstreamBuildFlavor: resolvedUpstreamBuildFlavor,
    hasOverride: selectedOverride != null,
  };
}

export function getBuildFlavorDisplayLabel(buildFlavor) {
  return DISPLAY_LABELS[buildFlavor] ?? null;
}

export function getBuildFlavorDisplayName({ productName, buildFlavor }) {
  const label = getBuildFlavorDisplayLabel(buildFlavor);
  return label == null ? productName : `${productName} (${label})`;
}

export function getDesktopIdForBuildFlavor(buildFlavor) {
  const desktopId = DESKTOP_IDS[buildFlavor];

  if (!desktopId) {
    throw new Error(`Missing desktop identifier for build flavor: ${buildFlavor}`);
  }

  return desktopId;
}

export function deriveArtifactName({ version, buildFlavor, upstreamBuildFlavor }) {
  const suffix = buildFlavor === upstreamBuildFlavor ? "" : `-${buildFlavor}`;
  return `Codex-${version}-linux-x64${suffix}.AppImage`;
}
