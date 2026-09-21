import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EVALUATION_SCHEMA,
  PLAN_SCHEMA,
  VEGA_ACTIONS,
} from "./plan.mjs";
import {
  executeTestPlan,
  finalizeTestRun,
  observeDevice,
  sendDeviceInput,
} from "./runner.mjs";

const EXIT = {
  success: 0,
  input: 1,
  testFailure: 2,
  environment: 3,
};

const COMMANDS = new Set(["schema", "observe", "input", "run", "report"]);

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help || !options.command) {
      printHelp();
      return;
    }
    if (!COMMANDS.has(options.command)) {
      throw new CliInputError(`Unknown command: ${options.command}`);
    }
  } catch (error) {
    printError(argv.includes("--json"), "invalid_options", errorMessage(error));
    process.exitCode = EXIT.input;
    return;
  }

  try {
    const result = await executeCommand(options);
    printResult(result, options.json);
    process.exitCode = result.command === "report" && !result.passed
      ? EXIT.testFailure
      : EXIT.success;
  } catch (error) {
    const message = errorMessage(error);
    const environmentFailure = /not found|No running Vega|VDA command failed|Automation Toolkit|failed to start/i.test(message);
    const inputFailure = error instanceof CliInputError;
    printError(
      options.json,
      inputFailure ? "invalid_input" : environmentFailure ? "environment_error" : "command_error",
      message
    );
    process.exitCode = inputFailure
      ? EXIT.input
      : environmentFailure ? EXIT.environment : EXIT.testFailure;
  }
}

export function parseArgs(argv) {
  const parsed = { command: undefined, positional: [] };
  const valueFlags = new Set([
    "out",
    "device",
    "vega",
    "repeat",
    "pause-ms",
    "plan",
    "evaluation",
  ]);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (!parsed.command) parsed.command = arg;
      else parsed.positional.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const name = arg.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);
    if (!valueFlags.has(name)) throw new CliInputError(`Unknown option: --${name}`);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith("--")) {
      throw new CliInputError(`Option --${name} requires a value.`);
    }
    parsed[flagKey(name)] = value;
  }

  return parsed;
}

async function executeCommand(options) {
  const onLog = options.json
    ? (message) => console.error(message)
    : (message) => console.log(message);

  if (options.command === "schema") {
    assertPositionalCount(options, 0);
    return {
      schemaVersion: 1,
      command: "schema",
      actions: VEGA_ACTIONS,
      plan: PLAN_SCHEMA,
      evaluation: EVALUATION_SCHEMA,
      examples: {
        plan: {
          name: "Move to Home",
          description: "Navigate to the current app's Home tile.",
          steps: [{
            action: "left",
            repeat: 3,
            pauseMs: 500,
            expect: "Home is focused and the Home content is visible.",
          }],
        },
        evaluation: {
          results: [{
            step: 1,
            passed: true,
            reason: "The UI context identifies tile-home as focused and the screenshot shows Home content.",
            observed: "Home focused",
          }],
        },
      },
    };
  }

  if (options.command === "observe") {
    assertPositionalCount(options, 0);
    return observeDevice({
      outDir: resolve(options.out ?? defaultOutputDir("observe")),
      deviceSerial: options.device,
      vegaPath: options.vega,
      pauseMs: parseInteger(options.pauseMs ?? "0", "pause-ms", 0, 10_000),
      onLog,
    });
  }

  if (options.command === "input") {
    assertPositionalCount(options, 1);
    const action = options.positional[0];
    if (!["up", "down", "left", "right", "select", "back", "home"].includes(action)) {
      throw new CliInputError(`Unsupported input action: ${action}`);
    }
    return sendDeviceInput({
      action,
      repeat: parseInteger(options.repeat ?? "1", "repeat", 1, 50),
      pauseMs: parseInteger(options.pauseMs ?? "350", "pause-ms", 0, 10_000),
      outDir: resolve(options.out ?? defaultOutputDir(`input-${action}`)),
      deviceSerial: options.device,
      vegaPath: options.vega,
      onLog,
    });
  }

  if (options.command === "run") {
    if (options.positional.length > 1) {
      throw new CliInputError("run accepts one plan path.");
    }
    const planPath = options.plan ?? options.positional[0];
    if (!planPath) {
      throw new CliInputError("run requires a plan path or --plan <path>.");
    }
    let plan;
    try {
      plan = readTextInput(planPath, "Plan");
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    try {
      return await executeTestPlan({
        plan,
        outDir: resolve(options.out ?? defaultOutputDir("run")),
        deviceSerial: options.device,
        vegaPath: options.vega,
        onLog,
      });
    } catch (error) {
      if (/test plan|Step \d|expectation|JSON object|unsupported action/i.test(errorMessage(error))) {
        throw new CliInputError(errorMessage(error));
      }
      throw error;
    }
  }

  if (options.command === "report") {
    assertPositionalCount(options, 1);
    if (!options.evaluation) {
      throw new CliInputError("report requires --evaluation <path>.");
    }
    let evaluation;
    try {
      evaluation = readTextInput(options.evaluation, "Evaluation");
      return finalizeTestRun({
        runDir: options.positional[0],
        evaluation,
      });
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
  }

  throw new CliInputError(`Unknown command: ${options.command}`);
}

function readTextInput(path, label) {
  if (path === "-") return readFileSync(0, "utf-8");
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return readFileSync(resolved, "utf-8");
}

function assertPositionalCount(options, expected) {
  if (options.positional.length !== expected) {
    throw new CliInputError(
      `${options.command} expects ${expected} positional argument${expected === 1 ? "" : "s"}.`
    );
  }
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new CliInputError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new CliInputError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function flagKey(name) {
  return name === "pause-ms" ? "pauseMs" : name;
}

function defaultOutputDir(command) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `vega-probe-results/${timestamp}-${command}`;
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.command === "schema") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.command === "observe" || result.command === "input") {
    const checkpoint = result.checkpoints[0];
    console.log(`\nVegaProbe ${result.command}: ${result.deviceSerial}`);
    console.log(`Focused: ${focusedLabels(checkpoint).join(", ") || "none"}`);
    console.log(`Screenshot: ${checkpoint.screenshot}`);
    console.log(`UI context: ${checkpoint.context}`);
    console.log(`Evidence: ${result.evidencePath}\n`);
    return;
  }

  if (result.command === "run") {
    console.log(`\nVegaProbe captured ${result.checkpoints.length} step(s) on ${result.deviceSerial}.`);
    console.log(`Evidence: ${result.evidencePath}`);
    console.log("Have the calling agent inspect each expected checkpoint, then run `vega-probe report`.\n");
    return;
  }

  console.log(`\nVegaProbe: ${result.passed ? "PASS" : "FAIL"}\n`);
  for (const evaluation of result.evaluations) {
    console.log(`${evaluation.passed ? "✓" : "✗"} Step ${evaluation.step}: ${evaluation.reason}`);
  }
  console.log(`\nReport: ${result.reportPath}`);
  console.log(`Result: ${result.resultPath}\n`);
}

function focusedLabels(checkpoint) {
  return checkpoint.summary.focused.map((element) =>
    element.description || element.text.join(" ") || element.testId || element.role || "unnamed element"
  );
}

function printError(json, code, message) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, error: { code, message } })}\n`);
  } else {
    console.error(`vega-probe: ${message}`);
  }
}

function printHelp() {
  console.log(`
vega-probe — agent-neutral control and test evidence for Vega VDA

Usage:
  vega-probe schema [--json]
  vega-probe observe [--out <path>] [--json]
  vega-probe input <action> [--repeat <n>] [--pause-ms <ms>] [--json]
  vega-probe run <plan.json> [--out <path>] [--json]
  vega-probe report <run-dir> --evaluation <evaluation.json> [--json]

Commands:
  schema    Print plan and evaluation JSON schemas
  observe   Capture the current screenshot and Vega UI context
  input     Send a D-pad or remote input, then capture evidence
  run       Execute a deterministic JSON plan and capture every step
  report    Validate agent-provided verdicts and write result.json/report.md

Options:
  --out <path>          Write screenshots, UI contexts, and evidence here
  --device <serial>     Select a VDA device (default: first connected device)
  --vega <path>         Path to the Vega CLI
  --repeat <n>          Repeat an input 1-50 times (default: 1)
  --pause-ms <ms>       Wait 0-10000 ms after inputs or before observation
  --plan <path>         Plan path alternative for the run command
  --evaluation <path>   Agent verdict JSON for the report command
  --json                Emit one machine-readable JSON object
  --help                Show this help

VegaProbe makes no model or external-service calls. The calling agent creates
plans, reads screenshots/UI context, and supplies evaluation verdicts.

Exit codes:
  0  Command succeeded, or evaluated test passed
  1  Invalid command, plan, or evaluation
  2  Evaluated test failed
  3  Missing Vega CLI, VDA, or Automation Toolkit environment
`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class CliInputError extends Error {}
