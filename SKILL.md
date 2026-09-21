---
name: vega-probe
description: Control and inspect a Vega Virtual Device with local screenshots and UI context, or execute and evaluate deterministic TV navigation plans. Use for Vega VDA focus, navigation, and visible UI checks; do not use for Android TV devices.
---

# VegaProbe

Use `vega-probe` as the local device-and-evidence layer. VegaProbe makes no
model calls: the current agent plans the actions and evaluates the results.

From this package, use `node ./bin/vega-probe.mjs`; use `vega-probe` when the
package binary is installed or linked.

## Choose a mode

For adaptive navigation, observe first and send small bounded inputs:

```sh
vega-probe observe --out ./vega-probe-results/<name>-observe --json
vega-probe input left --repeat 2 --pause-ms 500 \
  --out ./vega-probe-results/<name>-input --json
```

Read the screenshot and UI-context paths returned in `evidence.json`. Continue
only while the observed state supports the next action.

For a repeatable scenario, inspect the contract with `vega-probe schema
--json`, write a plan containing at least one `expect`, then run it:

```sh
vega-probe run ./plan.json --out ./vega-probe-results/<name>-run --json
```

Inspect every expected checkpoint. Treat UI context as authoritative for focus
identity and the screenshot as authoritative for visible appearance. If they
are out of sync during a transition, wait and use `observe` for a settled
capture.

Write one verdict per expected step and finalize it:

```sh
vega-probe report ./vega-probe-results/<name>-run \
  --evaluation ./evaluation.json --json
```

Report pass/fail reasons and link the screenshot and context evidence.

## Constraints

- Supported plan actions are `up`, `down`, `left`, `right`, `select`, `back`,
  `home`, `wait`, and `observe`.
- `home` is the system remote Home key. Use D-pad navigation when the user
  means an in-app Home screen.
- Use `--device <serial>` only when a particular VDA is required.
- Do not silently change the user's scenario, device, or expected outcome.
- On exit `3`, report the missing environment requirement and stop.
- On exit `2`, report the failed verdict; do not rerun without user approval.
