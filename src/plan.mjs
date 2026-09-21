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

export const PLAN_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "VegaProbe plan",
  type: "object",
  required: ["name", "steps"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: ["action"],
        additionalProperties: false,
        properties: {
          action: { enum: VEGA_ACTIONS },
          repeat: { type: "integer", minimum: 1, maximum: 50, default: 1 },
          pauseMs: { type: "integer", minimum: 0, maximum: 10_000, default: 350 },
          expect: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const EVALUATION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "VegaProbe evaluation",
  type: "object",
  required: ["results"],
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["step", "passed", "reason"],
        additionalProperties: false,
        properties: {
          step: { type: "integer", minimum: 1 },
          passed: { type: "boolean" },
          reason: { type: "string", minLength: 1 },
          observed: { type: "string" },
        },
      },
    },
  },
};

export function parseTestPlan(input) {
  const value = parseJsonInput(input);
  assertObject(value, "The test plan must be a JSON object.");
  assertOnlyKeys(value, ["name", "description", "steps"], "The test plan");

  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("The test plan must include a non-empty name.");
  }

  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 100) {
    throw new Error("The test plan must contain between 1 and 100 steps.");
  }

  const steps = rawSteps.map((rawStep, index) => {
    assertObject(rawStep, `Step ${index + 1} must be an object.`);
    assertOnlyKeys(rawStep, ["action", "repeat", "pauseMs", "expect"], `Step ${index + 1}`);
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

  const name = value.name.trim();
  const description = typeof value.description === "string" && value.description.trim()
    ? value.description.trim()
    : undefined;
  return { name, ...(description ? { description } : {}), steps };
}

export function parseEvaluation(input) {
  const value = parseJsonInput(input);
  assertObject(value, "The evaluation must be a JSON object.");
  assertOnlyKeys(value, ["results"], "The evaluation");
  if (!Array.isArray(value.results)) {
    throw new Error("The evaluation must include a results array.");
  }

  const seenSteps = new Set();
  const results = value.results.map((rawResult, index) => {
    assertObject(rawResult, `Evaluation result ${index + 1} must be an object.`);
    assertOnlyKeys(
      rawResult,
      ["step", "passed", "reason", "observed"],
      `Evaluation result ${index + 1}`
    );
    if (!Number.isInteger(rawResult.step) || rawResult.step < 1) {
      throw new Error(`Evaluation result ${index + 1} has an invalid step.`);
    }
    if (seenSteps.has(rawResult.step)) {
      throw new Error(`Evaluation step ${rawResult.step} appears more than once.`);
    }
    seenSteps.add(rawResult.step);
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

  return { results, overallPassed: results.every((result) => result.passed) };
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

  throw new Error("Input did not contain a JSON object.");
}

function parseJsonInput(input) {
  return typeof input === "string" ? extractJson(input) : input;
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertOnlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`);
  }
}
