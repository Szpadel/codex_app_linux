import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256File } from "./common.mjs";

test("sha256File returns the file content digest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-common-"));

  try {
    const filePath = path.join(tempDir, "source.txt");
    await writeFile(filePath, "codex\n");

    assert.equal(
      await sha256File(filePath),
      "243b0dc9b847e66c440dca985e10fe0ce9e29c379b018ddd5747ba8948f84cc8",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
