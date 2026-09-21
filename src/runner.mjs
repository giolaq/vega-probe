import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { invokeClaude } from "./agent.mjs";
import { VegaAutomationClient, summarizeScreenContext } from "./automation.mjs";
import {
  buildEvaluationPrompt,
  buildPlanPrompt,
  parseEvaluation,
  parseTestPlan,
} from "./plan.mjs";

export async function runNaturalLanguageTest(options, dependencies = {}) {
  const invokeAgent = dependencies.invokeAgent ?? invokeClaude;
  const connectClient = dependencies.connectClient
    ?? ((clientOptions) => VegaAutomationClient.connect(clientOptions));
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "description.txt"), `${options.description.trim()}\n`);

  options.onLog?.("Converting the test description into deterministic Vega steps...");
  const planUsage = await invokeAgent(buildPlanPrompt(options.description), {
    cwd: options.cwd,
    model: options.model,
    claudePath: options.claudePath,
    timeoutMs: 120_000,
  });
  const plan = parseTestPlan(planUsage.text);
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  if (options.planOnly) {
    return {
      description: options.description,
      plan,
      executed: false,
      passed: true,
      outDir,
      checkpoints: [],
      evaluations: [],
      usage: { tokens: planUsage.tokens, costUsd: planUsage.costUsd },
    };
  }

  const client = await connectClient({
    vegaPath: options.vegaPath,
    deviceSerial: options.deviceSerial,
    onLog: options.onLog,
  });
  const checkpoints = [];

  try {
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      const stepNumber = index + 1;
      options.onLog?.(
        `Step ${stepNumber}: ${step.action}${step.repeat > 1 ? ` x${step.repeat}` : ""}${step.expect ? ` — expect ${step.expect}` : ""}`
      );

      if (step.action === "wait") {
        await sleep(step.pauseMs);
      } else if (step.action === "observe") {
        if (step.pauseMs > 0) await sleep(step.pauseMs);
      } else {
        for (let repeat = 0; repeat < step.repeat; repeat++) {
          await client.sendInput(step.action);
          if (step.pauseMs > 0) await sleep(step.pauseMs);
        }
      }

      const context = await client.getScreenContext();
      const summary = summarizeScreenContext(context);
      const stem = `${String(stepNumber).padStart(2, "0")}-${step.action}${step.repeat > 1 ? `-x${step.repeat}` : ""}`;
      const contextPath = join(outDir, `${stem}-context.json`);
      const screenshotPath = join(outDir, `${stem}.png`);

      writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
      writeFileSync(screenshotPath, await client.takeScreenshot());
      checkpoints.push({
        step: stepNumber,
        action: step.action,
        repeat: step.repeat,
        expect: step.expect,
        screenshot: screenshotPath,
        context: contextPath,
        summary,
      });
    }
  } finally {
    await client.close();
  }

  const expectedCheckpoints = checkpoints.filter((checkpoint) => checkpoint.expect);
  options.onLog?.(`Evaluating ${expectedCheckpoints.length} stated expectation(s)...`);
  const evaluationUsage = await invokeAgent(
    buildEvaluationPrompt(options.description, expectedCheckpoints),
    {
      cwd: options.cwd,
      model: options.model,
      claudePath: options.claudePath,
      timeoutMs: 180_000,
    }
  );
  const parsedEvaluation = parseEvaluation(evaluationUsage.text);
  const returnedByStep = new Map(
    parsedEvaluation.results.map((evaluation) => [evaluation.step, evaluation])
  );
  const evaluations = expectedCheckpoints.map((checkpoint) =>
    returnedByStep.get(checkpoint.step) ?? {
      step: checkpoint.step,
      passed: false,
      reason: "The agent did not return a verdict for this expectation.",
      observed: "missing verdict",
    }
  );

  const passed = evaluations.length === expectedCheckpoints.length
    && evaluations.every((evaluation) => evaluation.passed);
  const result = {
    description: options.description,
    plan,
    executed: true,
    passed,
    deviceSerial: client.deviceSerial,
    outDir,
    checkpoints,
    evaluations,
    usage: {
      tokens: planUsage.tokens + evaluationUsage.tokens,
      costUsd: planUsage.costUsd + evaluationUsage.costUsd,
    },
  };

  result.reportPath = writeReport(result);
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function writeReport(result) {
  const lines = [
    "# VegaProbe Test Report",
    "",
    `**Description:** ${result.description}`,
    `**Device:** ${result.deviceSerial}`,
    `**Result:** ${result.passed ? "PASS" : "FAIL"}`,
    `**Agent usage:** ${result.usage.tokens} tokens, $${result.usage.costUsd.toFixed(4)}`,
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

  const reportPath = join(result.outDir, "report.md");
  writeFileSync(reportPath, lines.join("\n"));
  return reportPath;
}

function focusedLabel(element) {
  return element.description || element.text.join(" ") || element.testId || element.role || "unnamed element";
}

function escapeTable(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
