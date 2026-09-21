import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runNaturalLanguageTest } from "./runner.mjs";

const EXIT = {
  success: 0,
  input: 1,
  testFailure: 2,
  environment: 3,
};

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(argv.includes("--json"), "invalid_options", message);
    process.exitCode = EXIT.input;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  let description;
  try {
    description = readDescription(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(options.json, "invalid_input", message);
    process.exitCode = EXIT.input;
    return;
  }
  if (!description) {
    printError(options.json, "missing_description", "Describe a test, pipe it on stdin, or pass --file <path>.");
    process.exitCode = EXIT.input;
    return;
  }
  if (!options.allowExternalAgent) {
    printError(
      options.json,
      "external_agent_consent_required",
      "Planning sends the description to Claude, and execution sends screenshots and UI context for evaluation. Rerun with --allow-external-agent only if you approve that data transfer."
    );
    process.exitCode = EXIT.input;
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(options.out ?? join("vega-probe-results", timestamp));
  const onLog = options.json
    ? (message) => console.error(message)
    : (message) => console.log(message);

  try {
    const result = await runNaturalLanguageTest({
      description,
      outDir,
      cwd: process.cwd(),
      deviceSerial: options.device,
      model: options.model,
      planOnly: options.plan,
      vegaPath: options.vega,
      claudePath: options.claude,
      onLog,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "vega-probe", ...result })}\n`);
    } else if (!result.executed) {
      console.log("\nVegaProbe Plan\n");
      for (const [index, step] of result.plan.steps.entries()) {
        console.log(`${index + 1}. ${step.action}${step.repeat > 1 ? ` x${step.repeat}` : ""}${step.expect ? ` — expect ${step.expect}` : ""}`);
      }
      console.log(`\nPlan: ${join(result.outDir, "plan.json")}`);
      console.log(`Agent usage: ${result.usage.tokens} tokens, $${result.usage.costUsd.toFixed(4)}\n`);
    } else {
      console.log(`\nVegaProbe: ${result.passed ? "PASS" : "FAIL"}\n`);
      for (const evaluation of result.evaluations) {
        console.log(`${evaluation.passed ? "✓" : "✗"} Step ${evaluation.step}: ${evaluation.reason}`);
      }
      console.log(`\nReport: ${result.reportPath}`);
      console.log(`Artifacts: ${result.outDir}`);
      console.log(`Agent usage: ${result.usage.tokens} tokens, $${result.usage.costUsd.toFixed(4)}\n`);
    }

    process.exitCode = result.executed && !result.passed
      ? EXIT.testFailure
      : EXIT.success;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const environmentFailure = /not found|No running Vega|VDA command failed|Automation Toolkit|failed to start/i.test(message);
    printError(
      options.json,
      environmentFailure ? "environment_error" : "test_error",
      message
    );
    process.exitCode = environmentFailure ? EXIT.environment : EXIT.testFailure;
  }
}

export function parseArgs(argv) {
  const parsed = { positional: [] };
  const valueFlags = new Set(["file", "out", "device", "model", "vega", "claude"]);

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
    if (arg === "--plan") {
      parsed.plan = true;
      continue;
    }
    if (arg === "--allow-external-agent") {
      parsed.allowExternalAgent = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const name = arg.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);
    if (!valueFlags.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value.`);
    parsed[name] = value;
  }

  return parsed;
}

function readDescription(options) {
  if (options.file) {
    const path = resolve(options.file);
    if (!existsSync(path)) throw new Error(`Test description not found: ${path}`);
    return readFileSync(path, "utf-8").trim();
  }
  if (options.positional.length > 0) return options.positional.join(" ").trim();
  if (!process.stdin.isTTY) return readFileSync(0, "utf-8").trim();
  return "";
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
vega-probe — agent-driven natural-language test runner for Vega VDA

Usage:
  vega-probe "Move right twice. Expect Test & Debug to be focused."
  vega-probe --file ./scenario.txt
  cat scenario.txt | vega-probe

Options:
  --file <path>      Read the test description from a text file
  --out <path>       Write screenshots, UI contexts, and reports here
  --device <serial>  Select a VDA device (default: first connected device)
  --model <name>     Override the Claude model
  --vega <path>      Path to the Vega CLI
  --claude <path>    Path to the Claude CLI
  --allow-external-agent
                     Allow descriptions, screenshots, and UI context to be sent
                     to the configured Claude service
  --plan             Generate plan.json without touching the device
  --json             Emit one machine-readable JSON object
  --help             Show this help

Exit codes:
  0  Passed, or plan generated
  1  Invalid input
  2  Test or agent evaluation failed
  3  Missing tool or simulator environment
`);
}
