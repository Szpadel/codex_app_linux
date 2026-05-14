import assert from "node:assert/strict";
import test from "node:test";

import {
  disableTransparentWindowsInMainProcessBundle,
  resolveMainProcessBundlePathFromBootstrapSource,
} from "./patch-packaged-app.mjs";

test("resolveMainProcessBundlePathFromBootstrapSource discovers the hashed main-process bundle", () => {
  const bootstrapSource =
    "t.app.whenReady().then(async()=>{let{runMainAppStartup:e}=await Promise.resolve().then(()=>require(`./main-abc123.js`));await e()})";

  assert.equal(
    resolveMainProcessBundlePathFromBootstrapSource(bootstrapSource),
    ".vite/build/main-abc123.js",
  );
});

test("resolveMainProcessBundlePathFromBootstrapSource fails fast when bootstrap stops naming a single bundle", () => {
  assert.throws(
    () => resolveMainProcessBundlePathFromBootstrapSource("require(`./chunk.js`)"),
    /exactly one main-process bundle/,
  );
});

test("disableTransparentWindowsInMainProcessBundle forces shared auxiliary windows opaque", () => {
  const bundleSource =
    "function rG({alwaysOnTop:e,hasShadow:t=!0,platform:n,resizable:r,thickFrame:i,transparent:a=!0}){return{frame:!1,transparent:a,hasShadow:t,resizable:r}}function iG({appearance:e,opaqueWindowsEnabled:t,platform:n}){switch(e){case`browserCommentPopup`:return rG({platform:n,resizable:!1,thickFrame:!1,transparent:!0});case`globalDictation`:return rG({alwaysOnTop:!0,platform:n,resizable:!1,thickFrame:!1,transparent:!0});case`avatarOverlay`:return{...rG({alwaysOnTop:!0,platform:n,resizable:!1,thickFrame:!1}),hasShadow:!1};case`hotkeyWindowHome`:return rG({platform:n,resizable:!1,thickFrame:!1});case`hotkeyWindowThread`:return rG({platform:n,resizable:!0});}}";

  const patched = disableTransparentWindowsInMainProcessBundle(bundleSource);

  assert.match(patched, /transparent:0,hasShadow/);
  assert.doesNotMatch(patched, /transparent:a,hasShadow/);
  assert.match(patched, /transparent:!0/);
});

test("disableTransparentWindowsInMainProcessBundle fails fast when the target snippet changes", () => {
  assert.throws(
    () => disableTransparentWindowsInMainProcessBundle("function rG(){return{frame:!1}}"),
    /expected browserCommentPopup appearance case|Expected exactly one shared transparent BrowserWindow option/,
  );
});
