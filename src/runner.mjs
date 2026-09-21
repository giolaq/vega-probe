import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VegaAutomationClient, summarizeScreenContext } from "./automation.mjs";
import { parseEvaluation, parseTestPlan } from "./plan.mjs";

const DEVICE_ACTIONS = new Set(["up", "down", "left", "right", "select", "back", "home"]);

export async function observeDevice(options, dependencies = {}) {
  const connectClient = dependencies.connectClient
    ?? ((clientOptions) => VegaAutomationClient.connect(clientOptions));
  const outDir = prepareOutputDir(options.outDir);
  const client = await connectClient(clientOptions(options));

  try {
    if (options.pauseMs > 0) await sleep(options.pauseMs);
    const checkpoint = await captureCheckpoint(client, outDir, {
      step: 1,
      action: "observe",
      repeat: 1,
      pauseMs: options.pauseMs ?? 0,
    }, "observe");
    return writeEvidence(outDir, {
      schemaVersion: 1,
      command: "observe",
      deviceSerial: client.deviceSerial,
      outDir,
      checkpoints: [checkpoint],
    });
  } finally {
    await client.close();
  }
}

export async function sendDeviceInput(options, dependencies = {}) {
  if (!DEVICE_ACTIONS.has(options.action)) {
    throw new Error(`Input action must be one of: ${[...DEVICE_ACTIONS].join(", ")}.`);
  }
  assertRepeat(options.repeat);
  assertPause(options.pauseMs);

  const connectClient = dependencies.connectClient
    ?? ((clientOptions) => VegaAutomationClient.connect(clientOptions));
  const outDir = prepareOutputDir(options.outDir);
  const client = await connectClient(clientOptions(options));

  try {
    for (let index = 0; index < options.repeat; index++) {
      await client.sendInput(options.action);
      if (options.pauseMs > 0) await sleep(options.pauseMs);
    }
    const suffix = options.repeat > 1 ? `-x${options.repeat}` : "";
    const checkpoint = await captureCheckpoint(client, outDir, {
      step: 1,
      action: options.action,
      repeat: options.repeat,
      pauseMs: options.pauseMs,
    }, `input-${options.action}${suffix}`);
    return writeEvidence(outDir, {
      schemaVersion: 1,
      command: "input",
      deviceSerial: client.deviceSerial,
      outDir,
      checkpoints: [checkpoint],
    });
  } finally {
    await client.close();
  }
}

export async function executeTestPlan(options, dependencies = {}) {
  const plan = parseTestPlan(options.plan);
  const connectClient = dependencies.connectClient
    ?? ((clientOptions) => VegaAutomationClient.connect(clientOptions));
  const outDir = prepareOutputDir(options.outDir);
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  const client = await connectClient(clientOptions(options));
  const checkpoints = [];

  try {
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      const stepNumber = index + 1;
      options.onLog?.(
        `Step ${stepNumber}: ${step.action}${step.repeat > 1 ? ` x${step.repeat}` : ""}${step.expect ? ` — expect ${step.expect}` : ""}`
      );

      if (step.action === "wait" || step.action === "observe") {
        for (let repeat = 0; repeat < step.repeat; repeat++) {
          if (step.pauseMs > 0) await sleep(step.pauseMs);
        }
      } else {
        for (let repeat = 0; repeat < step.repeat; repeat++) {
          await client.sendInput(step.action);
          if (step.pauseMs > 0) await sleep(step.pauseMs);
        }
      }

      const suffix = step.repeat > 1 ? `-x${step.repeat}` : "";
      checkpoints.push(await captureCheckpoint(
        client,
        outDir,
        { step: stepNumber, ...step },
        `${String(stepNumber).padStart(2, "0")}-${step.action}${suffix}`
      ));
    }
  } finally {
    await client.close();
  }

  return writeEvidence(outDir, {
    schemaVersion: 1,
    command: "run",
    status: "captured",
    deviceSerial: client.deviceSerial,
    outDir,
    plan,
    checkpoints,
  });
}

export function finalizeTestRun(options) {
  const runDir = resolve(options.runDir);
  const evidencePath = join(runDir, "evidence.json");
  if (!existsSync(evidencePath)) {
    throw new Error(`Run evidence not found: ${evidencePath}`);
  }

  const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
  if (evidence.command !== "run" || !Array.isArray(evidence.checkpoints)) {
    throw new Error("The run directory does not contain VegaProbe run evidence.");
  }

  const parsedEvaluation = parseEvaluation(options.evaluation);
  const expectedCheckpoints = evidence.checkpoints.filter((checkpoint) => checkpoint.expect);
  const expectedSteps = new Set(expectedCheckpoints.map((checkpoint) => checkpoint.step));
  for (const evaluation of parsedEvaluation.results) {
    if (!expectedSteps.has(evaluation.step)) {
      throw new Error(`Evaluation references unexpected step ${evaluation.step}.`);
    }
  }

  const returnedByStep = new Map(
    parsedEvaluation.results.map((evaluation) => [evaluation.step, evaluation])
  );
  const evaluations = expectedCheckpoints.map((checkpoint) =>
    returnedByStep.get(checkpoint.step) ?? {
      step: checkpoint.step,
      passed: false,
      reason: "The calling agent did not return a verdict for this expectation.",
      observed: "missing verdict",
    }
  );
  const passed = evaluations.length > 0 && evaluations.every((evaluation) => evaluation.passed);
  const resultPath = join(runDir, "result.json");
  const reportPath = join(runDir, "report.md");
  const result = {
    schemaVersion: 1,
    command: "report",
    passed,
    runDir,
    evidencePath,
    resultPath,
    reportPath,
    deviceSerial: evidence.deviceSerial,
    plan: evidence.plan,
    checkpoints: evidence.checkpoints,
    evaluations,
  };

  writeFileSync(reportPath, writeReport(result));
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function clientOptions(options) {
  return {
    vegaPath: options.vegaPath,
    deviceSerial: options.deviceSerial,
    onLog: options.onLog,
  };
}

function prepareOutputDir(outDir) {
  const resolved = resolve(outDir);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function captureCheckpoint(client, outDir, step, stem) {
  const context = await client.getScreenContext();
  const screenshotPath = join(outDir, `${stem}.png`);
  const contextPath = join(outDir, `${stem}-context.json`);
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  writeFileSync(screenshotPath, await client.takeScreenshot());
  return {
    ...step,
    screenshot: screenshotPath,
    context: contextPath,
    summary: summarizeScreenContext(context),
    capturedAt: new Date().toISOString(),
  };
}

function writeEvidence(outDir, value) {
  const evidencePath = join(outDir, "evidence.json");
  const evidence = { ...value, evidencePath };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function writeReport(result) {
  const title = result.plan?.name ?? "VegaProbe test";
  const description = result.plan?.description;
  const lines = [
    "# VegaProbe Test Report",
    "",
    `**Test:** ${title}`,
    ...(description ? [`**Description:** ${description}`] : []),
    `**Device:** ${result.deviceSerial}`,
    `**Result:** ${result.passed ? "PASS" : "FAIL"}`,
    "",
    "## Steps",
    "",
    "| Step | Action | Expectation | Result | Evidence |",
    "| --- | --- | --- | --- | --- |",
  ];

  const evaluations = new Map(
    result.evaluations.map((evaluation) => [evaluation.step, evaluation])
  );
  for (const checkpoint of result.checkpoints) {
    const evaluation = evaluations.get(checkpoint.step);
    const action = `${checkpoint.action}${checkpoint.repeat > 1 ? ` x${checkpoint.repeat}` : ""}`;
    const status = evaluation ? (evaluation.passed ? "PASS" : "FAIL") : "CAPTURED";
    const evidence = evaluation
      ? evaluation.reason
      : checkpoint.summary.focused.map(focusedLabel).join(", ");
    lines.push(`| ${checkpoint.step} | ${action} | ${escapeTable(checkpoint.expect ?? "")} | ${status} | ${escapeTable(evidence)} |`);
  }

  lines.push("", "## Artifacts", "");
  for (const checkpoint of result.checkpoints) {
    lines.push(`- Step ${checkpoint.step}: \`${checkpoint.screenshot}\`, \`${checkpoint.context}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function focusedLabel(element) {
  return element.description || element.text.join(" ") || element.testId || element.role || "unnamed element";
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function assertRepeat(value) {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("repeat must be an integer from 1 to 50.");
  }
}

function assertPause(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("pause-ms must be an integer from 0 to 10000.");
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
