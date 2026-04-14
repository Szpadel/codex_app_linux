import { spawn } from "node:child_process";
import { once } from "node:events";

export const REQUIRED_STARTUP_MARKERS = ["packaged=true"];
export const FORBIDDEN_STARTUP_MARKERS = ["packaged=false", "localhost:5175", "ERR_CONNECTION_REFUSED"];

function formatCapturedLogs(stdout, stderr) {
  return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
}

function buildFailure(message, stdout, stderr) {
  return new Error(`${message}\n${formatCapturedLogs(stdout, stderr)}`);
}

function hasAllMarkers(logOutput, markers) {
  return markers.every((marker) => logOutput.includes(marker));
}

function findForbiddenMarker(logOutput, markers) {
  return markers.find((marker) => logOutput.includes(marker)) ?? null;
}

async function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  const timeoutPromise = new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(false), timeoutMs);
    timeoutId.unref?.();
  });

  return await Promise.race([once(child, "close").then(() => true), timeoutPromise]);
}

function signalProcessGroup(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

export async function terminateProcessGroup(child, { graceMs = 1_500, forceKillMs = 1_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalProcessGroup(child, "SIGTERM");

  if (await waitForClose(child, graceMs)) {
    return;
  }

  signalProcessGroup(child, "SIGKILL");

  if (await waitForClose(child, forceKillMs)) {
    return;
  }

  throw new Error(`Process tree did not exit after SIGKILL within ${forceKillMs}ms.`);
}

export async function runRuntimeSmoke({
  command,
  args = [],
  env,
  timeoutMs = 20_000,
  shutdownGraceMs = 1_500,
  forceKillMs = 1_000,
  requiredMarkers = REQUIRED_STARTUP_MARKERS,
  forbiddenMarkers = FORBIDDEN_STARTUP_MARKERS,
  onStatus,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let successObserved = false;
    let settled = false;

    const deadlineId = setTimeout(() => {
      void settleFailure(
        buildFailure(`Smoke test timed out after ${timeoutMs}ms before startup markers were observed.`, stdout, stderr),
      );
    }, timeoutMs);
    deadlineId.unref?.();

    async function finalize(callback) {
      clearTimeout(deadlineId);

      try {
        await terminateProcessGroup(child, { graceMs: shutdownGraceMs, forceKillMs });
      } catch (error) {
        callback(
          buildFailure(
            `Smoke test could not terminate the launched process tree: ${error instanceof Error ? error.message : String(error)}`,
            stdout,
            stderr,
          ),
        );
        return;
      }

      callback();
    }

    async function settleSuccess() {
      if (settled) {
        return;
      }

      settled = true;
      onStatus?.({ type: "required-markers-observed" });
      await finalize(() => resolve({ stdout, stderr }));
    }

    async function settleFailure(error) {
      if (settled) {
        return;
      }

      settled = true;
      await finalize((terminationError) => reject(terminationError ?? error));
    }

    function inspectLogs() {
      if (settled) {
        return;
      }

      const combinedOutput = `${stdout}\n${stderr}`;
      const forbiddenMarker = findForbiddenMarker(combinedOutput, forbiddenMarkers);

      if (forbiddenMarker) {
        onStatus?.({ type: "forbidden-marker", marker: forbiddenMarker });
        void settleFailure(
          buildFailure(`Smoke test log contains forbidden marker "${forbiddenMarker}".`, stdout, stderr),
        );
        return;
      }

      if (hasAllMarkers(combinedOutput, requiredMarkers)) {
        successObserved = true;
        void settleSuccess();
      }
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      inspectLogs();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      inspectLogs();
    });

    child.on("error", (error) => {
      void settleFailure(
        buildFailure(
          `Smoke test failed to launch: ${error instanceof Error ? error.message : String(error)}`,
          stdout,
          stderr,
        ),
      );
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (successObserved) {
        void settleSuccess();
        return;
      }

      const exitDetail = signal ? `signal ${signal}` : `code ${code}`;
      void settleFailure(
        buildFailure(`Smoke test process exited before startup markers were observed (${exitDetail}).`, stdout, stderr),
      );
    });
  });
}
