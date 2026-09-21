# VegaProbe

VegaProbe is an agent-neutral control and test-evidence CLI for the Vega
Virtual Device. It sends bounded remote inputs, captures screenshots and Vega
UI context, and turns verdicts from the calling agent into a test report.

VegaProbe does not select or invoke a model. Any calling agent can use the same
local JSON interface and evaluate the evidence itself.

## Requirements

- Node.js 20 or newer.
- Vega SDK with a running Vega Virtual Device.

The package has no npm runtime dependencies and makes no external-service
calls.

## Install

From this directory:

```sh
npm link
```

You can now run `vega-probe` from any project. Without linking:

```sh
node ./bin/vega-probe.mjs --help
```

## Agent workflow

Start by inspecting the machine-readable contracts:

```sh
vega-probe schema --json
```

Observe the current app before deciding how to navigate:

```sh
vega-probe observe --json --out ./vega-probe-results/home-observe
```

The calling agent reads the returned screenshot and UI-context paths. It can
then navigate adaptively:

```sh
vega-probe input left --repeat 3 --pause-ms 500 --json \
  --out ./vega-probe-results/home-input
```

For a repeatable test, the calling agent writes a deterministic plan:

```json
{
  "name": "Move to Home",
  "description": "Navigate to the current app's Home tile.",
  "steps": [
    {
      "action": "left",
      "repeat": 3,
      "pauseMs": 500,
      "expect": "Home is focused and the Home content is visible."
    }
  ]
}
```

Run it:

```sh
vega-probe run ./plan.json --json \
  --out ./vega-probe-results/home-run
```

`run` executes the plan and writes `evidence.json`, screenshots, and raw UI
context. It does not claim that expectations passed. The calling agent must
inspect both evidence sources and write its verdict:

```json
{
  "results": [
    {
      "step": 1,
      "passed": true,
      "reason": "The UI context identifies tile-home as focused and the screenshot shows Home content.",
      "observed": "Home focused"
    }
  ]
}
```

Finalize the report:

```sh
vega-probe report ./vega-probe-results/home-run \
  --evaluation ./evaluation.json --json
```

This writes `result.json` and `report.md`. A failed verdict exits with code `2`.

## Commands

### `schema`

Prints supported actions and the plan and evaluation JSON Schemas.

```sh
vega-probe schema --json
```

### `observe`

Captures the current screen without sending input.

```sh
vega-probe observe [--pause-ms <ms>] [--out <path>] [--json]
```

### `input`

Sends one supported remote input, optionally repeated, then captures evidence.

```sh
vega-probe input <action> [--repeat <n>] [--pause-ms <ms>] \
  [--out <path>] [--json]
```

Input actions are `up`, `down`, `left`, `right`, `select`, `back`, and `home`.
The `home` action is the system remote Home button. Navigate with D-pad inputs
when the user means a Home screen inside the current app.

### `run`

Executes a JSON plan and captures every step:

```sh
vega-probe run <plan.json> [--out <path>] [--json]
```

Plan actions also support `wait` and `observe`. Plans contain 1–100 steps;
`repeat` is limited to 1–50 and `pauseMs` to 0–10000.

### `report`

Validates calling-agent verdicts and writes the final result:

```sh
vega-probe report <run-dir> --evaluation <evaluation.json> [--json]
```

Every step containing `expect` receives exactly one verdict. Missing verdicts
fail the test; duplicate or unexpected step numbers are rejected.

## Common options

- `--device <serial>` selects a VDA device; the first connected device is used
  by default.
- `--vega <path>` selects the Vega CLI. `VEGA_PATH` is also supported.
- `--out <path>` chooses the artifact directory.
- `--json` emits one machine-readable JSON object on stdout.

## Evidence

Device commands write:

- `evidence.json`: normalized command, device, checkpoints, and artifact paths.
- `plan.json`: normalized plan for a `run`.
- `NN-action.png`: framebuffer captured directly from Vega.
- `NN-action-context.json`: raw Vega accessibility/UI context.

`report` adds:

- `result.json`: machine-readable pass/fail result and verdicts.
- `report.md`: human-readable report with evidence paths.

Treat UI context as authoritative for focus identity and the screenshot as
authoritative for visible appearance. If they appear out of sync during an
animation, wait and use `observe` to capture a settled state.

## Device control

VegaProbe:

1. Discovers the VDA device through `vega exec vda devices`.
2. Enables `/tmp/automation-toolkit.enable`.
3. Forwards the toolkit's port `8383` to a temporary localhost port.
4. Calls `injectInputKeyEvent`, `getScreenContext`, and `takeScreenshot`.
5. Removes its port forward after the command.

It does not use `osascript` and does not require the simulator window to be
focused.

## Data handling

VegaProbe makes no model or external-service calls. Screenshots and UI context
remain local unless the calling agent's own environment transmits them. Apply
that agent's data-handling policy when testing sensitive screens.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded, or evaluated test passed |
| `1` | Invalid command, plan, or evaluation |
| `2` | Evaluated test failed |
| `3` | Vega CLI, VDA, or Automation Toolkit environment failure |

## Verify the package

```sh
npm run verify
npm pack --dry-run
```
