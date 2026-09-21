# VegaProbe

An agent-driven natural-language test runner for the Vega Virtual Device. It
does not import, invoke, or depend on TV Build.

The tester describes remote actions and observable expectations in plain
language. An agent converts the description into bounded input steps. The
runner sends those steps through Vega's Automation Toolkit, captures a
screenshot and UI tree after each step, and asks the agent to judge each
expectation.

## Requirements

- Node.js 20 or newer.
- Vega SDK with a running Vega Virtual Device.
- An authenticated Claude Code CLI.

The package has no npm runtime dependencies.

## Install

From this directory:

```sh
npm link
```

You can now run `vega-probe` from any project. Without linking:

```sh
node ./bin/vega-probe.mjs --help
```

## Run a test

```sh
vega-probe \
  --allow-external-agent \
  "Move right twice. Expect Test & Debug to be focused."
```

Longer scenarios can be ordinary text files:

```text
Start with Home focused.
Move right twice.
Expect Test & Debug to be focused.
Press OK.
Expect the Test & Debug screen to be visible.
```

```sh
vega-probe --allow-external-agent --file ./scenario.txt
```

The description can also be piped over stdin:

```sh
cat scenario.txt | vega-probe --allow-external-agent
```

## Inspect before execution

`--plan` asks the agent to create the bounded JSON plan but does not connect to
the simulator:

```sh
vega-probe --allow-external-agent --file ./scenario.txt --plan
```

Agent monetary cost is tracked but not capped.

## Use from an agent

`vega-probe` exposes a machine-readable CLI that can be called by Codex, Claude,
or another outer agent. The outer agent does not need to use a particular
model. The current implementation uses the locally configured Claude CLI
internally to translate the test description and evaluate captured evidence.

Model selection is optional. Omit `--model` to use the Claude CLI's configured
default, or pass `--model <name>` when a specific model is required.

An agent should use this workflow:

1. Explain that the test description is sent to the configured Claude service
   during planning, and screenshots plus UI context are sent during evaluation.
   Do not add `--allow-external-agent` until the human has approved that data
   transfer.
2. Generate and inspect a plan without touching the device:

   ```sh
   vega-probe --allow-external-agent --plan --json \
     --out ./vega-probe-results/my-test-plan \
     "Move right twice. Expect Test & Debug to be focused."
   ```

3. Show the human the generated steps, selected device if applicable, and
   accumulated agent cost. State that monetary cost is tracked but uncapped.
4. After the human confirms execution, run the test with a separate output
   directory:

   ```sh
   vega-probe --allow-external-agent --json \
     --out ./vega-probe-results/my-test-run \
     "Move right twice. Expect Test & Debug to be focused."
   ```

5. Report the pass/fail result, evaluation reasons, agent usage, and paths to
   `report.md`, screenshots, and UI context artifacts.

Use `--file <path>` for longer scenarios and `--device <serial>` only when the
human or environment requires a specific VDA. Exit codes are stable: `0` means
success, `1` invalid input, `2` test or evaluation failure, and `3` an
environment failure.

See [`SKILL.md`](./SKILL.md) for reusable agent instructions.

## Data disclosure

The Claude CLI sends the test description to its configured service to create
the plan. During evaluation it also receives the captured screenshot and a
summary of the Vega UI context. The runner refuses to make those calls unless
you pass `--allow-external-agent`.

Do not use that flag with sensitive screens unless your configured agent and
data-handling policy permit it.

## Artifacts

Each run writes:

- `description.txt`: original tester language.
- `plan.json`: deterministic remote actions and expectations.
- `NN-action.png`: framebuffer captured directly from Vega.
- `NN-action-context.json`: raw Vega accessibility/UI context.
- `result.json`: machine-readable verdicts and usage.
- `report.md`: human-readable results and evidence.

Use `--out <path>` to choose the artifact directory and `--json` for
machine-readable CLI output.

## Device control

The runner:

1. Discovers the VDA device through `vega exec vda devices`.
2. Enables `/tmp/automation-toolkit.enable`.
3. Forwards the toolkit's port `8383` to a temporary localhost port.
4. Calls `injectInputKeyEvent`, `getScreenContext`, and `takeScreenshot`.
5. Removes its port forward after the test.

This does not use `osascript` and does not require the simulator window to be
focused.

Supported actions are `up`, `down`, `left`, `right`, `select`, `back`, `home`,
`wait`, and `observe`.

## Configuration

```sh
vega-probe --allow-external-agent \
  --device emulator-5554 --model claude-sonnet-4-6 \
  --vega /path/to/vega --claude /path/to/claude \
  "Move left. Expect Home to be focused."
```

You can also set `VEGA_PATH` and `CLAUDE_PATH`.

## Verify the package

```sh
npm run verify
npm pack --dry-run
```
