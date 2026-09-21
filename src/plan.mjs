export const VEGA_ACTIONS = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "back",
  "home",
  "wait",
  "observe",
];

const ACTION_SET = new Set(VEGA_ACTIONS);

export function buildPlanPrompt(description) {
  return [
    "You translate a human-written TV remote test into a deterministic Vega test plan.",
    "Do not execute the test. Return only one JSON object and no markdown.",
    "",
    "Allowed actions:",
    "- up, down, left, right: D-pad directions",
    "- select: center/OK",
    "- back: remote Back",
    "- home: remote Home",
    "- wait: pause without input",
    "- observe: capture state without input",
    "",
    "Output contract:",
    '{"name":"short name","steps":[{"action":"right","repeat":2,"pauseMs":350,"expect":"Test & Debug is focused"}]}',
    "",
    "Rules:",
    "- Preserve the tester's order exactly.",
    "- Combine repeated identical actions using repeat.",
    "- Put an expectation on the step after which it should be checked.",
    "- If the tester only states an expectation, use observe.",
    "- Every explicit expectation must appear in exactly one step.",
    "- Use pauseMs 350 unless the tester requests another delay.",
    "- Do not invent expectations or actions.",
    "",
    "Tester description:",
    description.trim(),
  ].join("\n");
}

export function parseTestPlan(output) {
  const value = extractJson(output);
  assertObject(value, "The test plan must be a JSON object.");

  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 100) {
    throw new Error("The test plan must contain between 1 and 100 steps.");
  }

  const steps = rawSteps.map((rawStep, index) => {
    assertObject(rawStep, `Step ${index + 1} must be an object.`);
    if (!ACTION_SET.has(rawStep.action)) {
      throw new Error(`Step ${index + 1} has unsupported action: ${String(rawStep.action)}`);
    }

    const repeat = rawStep.repeat ?? 1;
    const pauseMs = rawStep.pauseMs ?? 350;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) {
      throw new Error(`Step ${index + 1} repeat must be an integer from 1 to 50.`);
    }
    if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 10_000) {
      throw new Error(`Step ${index + 1} pauseMs must be an integer from 0 to 10000.`);
    }

    const expect = typeof rawStep.expect === "string" && rawStep.expect.trim()
      ? rawStep.expect.trim()
      : undefined;
    return { action: rawStep.action, repeat, pauseMs, ...(expect ? { expect } : {}) };
  });

  if (!steps.some((step) => step.expect)) {
    throw new Error("At least one step must include an expectation.");
  }

  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : "Vega natural-language test";
  return { name, steps };
}

export function buildEvaluationPrompt(description, checkpoints) {
  const evidence = checkpoints.map((checkpoint) => ({
    step: checkpoint.step,
    expectation: checkpoint.expect,
    screenshot: checkpoint.screenshot,
    uiSummary: checkpoint.summary,
  }));

  return [
    "You are a strict TV application test oracle.",
    "Judge each expectation using both the screenshot and the Vega UI context summary.",
    "You MUST use the Read tool to inspect every screenshot listed below.",
    "Treat UI context as authoritative for focus identity and the screenshot as authoritative for visible appearance.",
    "If evidence is missing, ambiguous, or contradicts the expectation, fail that expectation.",
    "Return only one JSON object and no markdown.",
    "",
    "Output contract:",
    '{"results":[{"step":1,"passed":true,"reason":"concise evidence","observed":"what was observed"}],"overallPassed":true}',
    "",
    "Original tester description:",
    description.trim(),
    "",
    "Checkpoints:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

export function parseEvaluation(output) {
  const value = extractJson(output);
  assertObject(value, "The evaluation must be a JSON object.");
  if (!Array.isArray(value.results)) {
    throw new Error("The evaluation must include a results array.");
  }

  const results = value.results.map((rawResult, index) => {
    assertObject(rawResult, `Evaluation result ${index + 1} must be an object.`);
    if (!Number.isInteger(rawResult.step) || rawResult.step < 1) {
      throw new Error(`Evaluation result ${index + 1} has an invalid step.`);
    }
    if (typeof rawResult.passed !== "boolean") {
      throw new Error(`Evaluation result ${index + 1} must include passed=true or false.`);
    }
    if (typeof rawResult.reason !== "string" || !rawResult.reason.trim()) {
      throw new Error(`Evaluation result ${index + 1} must include a reason.`);
    }
    return {
      step: rawResult.step,
      passed: rawResult.passed,
      reason: rawResult.reason.trim(),
      ...(typeof rawResult.observed === "string" && rawResult.observed.trim()
        ? { observed: rawResult.observed.trim() }
        : {}),
    };
  });

  return {
    results,
    overallPassed: typeof value.overallPassed === "boolean"
      ? value.overallPassed
      : results.every((result) => result.passed),
  };
}

export function extractJson(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with fenced or embedded JSON.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));

  throw new Error("Agent response did not contain a JSON object.");
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}
