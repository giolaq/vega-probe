#!/usr/bin/env node

import { main } from "../src/cli.mjs";

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`vega-probe: ${message}`);
  process.exit(2);
});
