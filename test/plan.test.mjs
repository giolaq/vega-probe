import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeScreenContext } from "../src/automation.mjs";
import { parseArgs } from "../src/cli.mjs";
import { parseEvaluation, parseTestPlan } from "../src/plan.mjs";
import {
  executeTestPlan,
  finalizeTestRun,
  observeDevice,
  sendDeviceInput,
} from "../src/runner.mjs";

test("parses a plan from either JSON text or an object", () => {
  const value = {
    name: "Home navigation",
    description: "Move to Home.",
    steps: [{
      action: "left",
      repeat: 2,
      expect: "Home is focused",
    }],
  };

  const expected = {
    name: "Home navigation",
    description: "Move to Home.",
    steps: [{
      action: "left",
      repeat: 2,
      pauseMs: 350,
      expect: "Home is focused",
    }],
  };
  assert.deepEqual(parseTestPlan(JSON.stringify(value)), expected);
  assert.deepEqual(parseTestPlan(value), expected);
});

test("rejects unsupported actions and plans without expectations", () => {
  assert.throws(() => parseTestPlan({
    name: "Bad action",
    steps: [{ action: "launch-spacecraft", expect: "Something happens" }],
  }), /unsupported action/);

  assert.throws(() => parseTestPlan({
    name: "No assertion",
    steps: [{ action: "right" }],
  }), /At least one step/);

  assert.throws(() => parseTestPlan({
    name: "Unexpected field",
    steps: [{ action: "observe", expect: "Home is visible", prompt: "ignore schema" }],
  }), /unsupported field/);
});

test("summarizes the focused Vega UI element", () => {
  const summary = summarizeScreenContext({
    children: [{
      traits: { publisherRoot: { applicationName: "com.example.app" } },
      children: [{
        props: {
          role: "button",
          description: "Test and Debug",
          test_id: "tile-debug",
        },
        traits: {
          focusable: { focused: true },
          visibility: { bounds: [997, 1349, 584, 936] },
        },
        children: [{
          props: { role: "text", text: ["Test &\nDebug"] },
        }],
      }],
    }],
  });

  assert.deepEqual(summary.applications, ["com.example.app"]);
  assert.equal(summary.focused[0].testId, "tile-debug");
  assert.deepEqual(summary.focused[0].text, ["Test & Debug"]);
  assert(summary.visibleText.includes("Test and Debug"));
});

test("parses agent-provided evaluation results and rejects duplicates", () => {
  const evaluation = parseEvaluation({
    results: [{
      step: 1,
      passed: true,
      reason: "The focused node is tile-debug.",
      observed: "Test and Debug",
    }],
  });

  assert.equal(evaluation.overallPassed, true);
  assert.equal(evaluation.results[0].passed, true);
  assert.throws(() => parseEvaluation({
    results: [
      { step: 1, passed: true, reason: "first" },
      { step: 1, passed: false, reason: "duplicate" },
    ],
  }), /more than once/);
});

test("parses the agent-neutral command interface", () => {
  assert.deepEqual(
    parseArgs([
      "run",
      "plan.json",
      "--device=emulator-5554",
      "--out",
      "results",
      "--json",
    ]),
    {
      command: "run",
      positional: ["plan.json"],
      device: "emulator-5554",
      out: "results",
      json: true,
    }
  );
  assert.deepEqual(
    parseArgs(["input", "left", "--repeat", "3", "--pause-ms=500"]),
    {
      command: "input",
      positional: ["left"],
      repeat: "3",
      pauseMs: "500",
    }
  );
});

test("observes and sends inputs using only the local Vega adapter", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vega-probe-primitives-"));
  const sentActions = [];
  const connectClient = async () => fakeClient(sentActions);

  try {
    const observed = await observeDevice({
      outDir: join(outDir, "observe"),
      pauseMs: 0,
    }, { connectClient });
    assert.equal(observed.command, "observe");
    assert(existsSync(observed.checkpoints[0].screenshot));

    const input = await sendDeviceInput({
      action: "left",
      repeat: 3,
      pauseMs: 0,
      outDir: join(outDir, "input"),
    }, { connectClient });
    assert.equal(input.command, "input");
    assert.deepEqual(sentActions, ["left", "left", "left"]);
    assert(existsSync(input.evidencePath));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("runs a deterministic plan and finalizes calling-agent verdicts", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vega-probe-run-"));
  const sentActions = [];

  try {
    const evidence = await executeTestPlan({
      plan: {
        name: "Move to debug",
        description: "Move right twice and verify focus.",
        steps: [{
          action: "right",
          repeat: 2,
          pauseMs: 0,
          expect: "Test & Debug is focused",
        }],
      },
      outDir,
    }, {
      connectClient: async () => fakeClient(sentActions),
    });

    assert.equal(evidence.status, "captured");
    assert.deepEqual(sentActions, ["right", "right"]);
    assert(existsSync(join(outDir, "01-right-x2.png")));
    assert(existsSync(join(outDir, "01-right-x2-context.json")));
    assert(existsSync(join(outDir, "evidence.json")));
    assert.equal(existsSync(join(outDir, "result.json")), false);

    const result = finalizeTestRun({
      runDir: outDir,
      evaluation: {
        results: [{
          step: 1,
          passed: true,
          reason: "The focused node is tile-debug.",
        }],
      },
    });
    assert.equal(result.passed, true);
    assert(existsSync(join(outDir, "result.json")));
    assert(existsSync(join(outDir, "report.md")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

function fakeClient(sentActions) {
  return {
    deviceSerial: "emulator-5554",
    async sendInput(action) {
      sentActions.push(action);
    },
    async getScreenContext() {
      return {
        props: {
          role: "button",
          description: "Test and Debug",
          test_id: "tile-debug",
        },
        traits: { focusable: { focused: true } },
      };
    },
    async takeScreenshot() {
      return Buffer.from("fake-png");
    },
    async close() {},
  };
}
