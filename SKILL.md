---
name: vega-probe
description: Plan and run natural-language TV navigation and UI expectation tests against a running Vega Virtual Device using the local vega-probe CLI. Use for Vega VDA focus, navigation, screenshots, and observable UI checks; do not use for Android TV devices.
---

# VegaProbe

Use `vega-probe` to convert a natural-language scenario into bounded remote
actions, execute those actions against a Vega Virtual Device, capture
screenshots and UI context, and report expectation verdicts.

The calling agent may use any model. `vega-probe` currently invokes the locally
configured Claude CLI internally for planning and evidence evaluation. Omit
`--model` unless the user requests a specific Claude model.

## Consent

Before the first invocation, tell the user that:

- planning sends the test description to the configured Claude service;
- execution sends screenshots and summarized Vega UI context for evaluation;
- monetary cost is tracked but uncapped.

Use `--allow-external-agent` only after the user explicitly approves this data
transfer. Do not run tests containing sensitive screens unless the user
confirms that the configured service and data-handling policy are appropriate.

## Workflow

From this package, use `node ./bin/vega-probe.mjs`; use `vega-probe` when the
package binary is installed or linked.

First create a plan without touching the device:

```sh
vega-probe --allow-external-agent --plan --json \
  --out ./vega-probe-results/<test-name>-plan \
  "<natural-language scenario>"
```

Read the JSON result and `plan.json`. Show the user the ordered actions,
expectations, optional device selection, and accumulated cost. Wait for
confirmation before executing the device actions.

Then run the approved scenario with a separate output directory:

```sh
vega-probe --allow-external-agent --json \
  --out ./vega-probe-results/<test-name>-run \
  "<natural-language scenario>"
```

For a long scenario, prefer `--file <path>`. Add `--device <serial>` only when
a particular VDA is required. Supported actions are `up`, `down`, `left`,
`right`, `select`, `back`, `home`, `wait`, and `observe`.

After execution, report:

- overall pass or failure and each evaluation reason;
- token usage and monetary cost;
- the paths to `report.md`, screenshots, and UI context JSON;
- any environment error without silently changing the device or scenario.

## Exit Codes

- `0`: passed, or plan generated;
- `1`: invalid input;
- `2`: test execution or agent evaluation failed;
- `3`: Vega CLI, VDA, Automation Toolkit, or another environment requirement
  is unavailable.

If the command exits `3`, report the missing requirement and stop. If it exits
`2`, inspect the JSON error or generated report and explain the failed
expectation; do not rewrite the user's scenario or rerun it without approval.
