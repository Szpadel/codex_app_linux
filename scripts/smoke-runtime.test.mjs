import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeSmoke } from "./smoke-runtime.mjs";

function childArgs(source) {
  return ["--input-type=module", "-e", source];
}

test("runRuntimeSmoke resolves once required startup markers are observed", async () => {
  const result = await runRuntimeSmoke({
    command: process.execPath,
    args: childArgs(`
      console.log("boot");
      setTimeout(() => console.log("Launching app packaged=true platform=linux"), 50);
      setInterval(() => {}, 1000);
    `),
    env: process.env,
    timeoutMs: 1_000,
    shutdownGraceMs: 200,
    forceKillMs: 200,
  });

  assert.match(result.stdout, /packaged=true/);
});

test("runRuntimeSmoke rejects immediately on forbidden startup markers", async () => {
  await assert.rejects(
    runRuntimeSmoke({
      command: process.execPath,
      args: childArgs(`
        console.log("http://localhost:5175/?hostId=local");
        setInterval(() => {}, 1000);
      `),
      env: process.env,
      timeoutMs: 1_000,
      shutdownGraceMs: 200,
      forceKillMs: 200,
    }),
    /forbidden marker "localhost:5175"/,
  );
});

test("runRuntimeSmoke fails when startup markers never appear", async () => {
  await assert.rejects(
    runRuntimeSmoke({
      command: process.execPath,
      args: childArgs(`
        setInterval(() => {}, 1000);
      `),
      env: process.env,
      timeoutMs: 250,
      shutdownGraceMs: 100,
      forceKillMs: 100,
    }),
    /timed out after 250ms/,
  );
});
