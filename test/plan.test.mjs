import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeScreenContext } from "../src/automation.mjs";
import { parseArgs } from "../src/cli.mjs";
import { parseEvaluation, parseTestPlan } from "../src/plan.mjs";
import { runNaturalLanguageTest } from "../src/runner.mjs";

test("parses a fenced plan and applies defaults", () => {
  const plan = parseTestPlan([
    "```json",
    JSON.stringify({
      name: "Home navigation",
      steps: [{
        action: "right",
        repeat: 2,
        expect: "Test & Debug is focused",
      }],
    }),
    "```",
  ].join("\n"));

  assert.deepEqual(plan, {
    name: "Home navigation",
    steps: [{
      action: "right",
      repeat: 2,
      pauseMs: 350,
      expect: "Test & Debug is focused",
    }],
  });
});

test("rejects unsupported actions and plans without expectations", () => {
  assert.throws(() => parseTestPlan(JSON.stringify({
    name: "Bad action",
    steps: [{ action: "launch-spacecraft", expect: "Something happens" }],
  })), /unsupported action/);

  assert.throws(() => parseTestPlan(JSON.stringify({
    name: "No assertion",
    steps: [{ action: "right" }],
  })), /At least one step/);
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

test("parses evaluation results", () => {
  const evaluation = parseEvaluation(JSON.stringify({
    results: [{
      step: 1,
      passed: true,
      reason: "The focused node is tile-debug.",
      observed: "Test and Debug",
    }],
  }));

  assert.equal(evaluation.overallPassed, true);
  assert.equal(evaluation.results[0].passed, true);
});

test("parses reusable CLI options", () => {
  assert.deepEqual(
    parseArgs([
      "--file",
      "scenario.txt",
      "--device=emulator-5554",
      "--plan",
      "--allow-external-agent",
    ]),
    {
      positional: [],
      file: "scenario.txt",
      device: "emulator-5554",
      plan: true,
      allowExternalAgent: true,
    }
  );
});

test("runs planning, input, capture, and evaluation with local adapters", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vega-probe-"));
  const sentActions = [];
  let closed = false;
  let agentCall = 0;

  const invokeAgent = async () => {
    agentCall++;
    if (agentCall === 1) {
      return {
        text: JSON.stringify({
          name: "Move to debug",
          steps: [{
            action: "right",
            repeat: 2,
            pauseMs: 0,
            expect: "Test & Debug is focused",
          }],
        }),
        tokens: 10,
        costUsd: 0.01,
      };
    }
    return {
      text: JSON.stringify({
        results: [{
          step: 1,
          passed: true,
          reason: "The focused node is tile-debug.",
        }],
        overallPassed: true,
      }),
      tokens: 5,
      costUsd: 0.02,
    };
  };

  const connectClient = async () => ({
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
    async close() {
      closed = true;
    },
  });

  try {
    const result = await runNaturalLanguageTest({
      description: "Move right twice. Expect Test & Debug to be focused.",
      outDir,
      cwd: process.cwd(),
    }, {
      invokeAgent,
      connectClient,
    });

    assert.equal(result.passed, true);
    assert.deepEqual(sentActions, ["right", "right"]);
    assert.equal(closed, true);
    assert.equal(result.usage.tokens, 15);
    assert.equal(result.usage.costUsd, 0.03);
    assert(existsSync(join(outDir, "01-right-x2.png")));
    assert(existsSync(join(outDir, "01-right-x2-context.json")));
    assert(existsSync(join(outDir, "result.json")));
    assert(existsSync(join(outDir, "report.md")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
