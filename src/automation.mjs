import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const INPUT_CODES = {
  left: 105,
  right: 106,
  up: 103,
  down: 108,
  select: 96,
  back: 158,
  home: 170,
};

export class VegaAutomationClient {
  #requestId = 100;

  constructor(vegaBinary, deviceSerial, localPort) {
    this.vegaBinary = vegaBinary;
    this.deviceSerial = deviceSerial;
    this.localPort = localPort;
  }

  static async connect(options = {}) {
    const vegaBinary = resolveVegaBinary(options.vegaPath);
    const deviceSerial = options.deviceSerial ?? discoverVegaDevice(vegaBinary);

    options.onLog?.(`Connecting to Vega device ${deviceSerial}...`);
    runVda(vegaBinary, ["-s", deviceSerial, "shell", "touch", "/tmp/automation-toolkit.enable"]);
    const localPort = Number(runVda(
      vegaBinary,
      ["-s", deviceSerial, "forward", "tcp:0", "tcp:8383"]
    ));
    if (!Number.isInteger(localPort) || localPort <= 0) {
      throw new Error(`VDA returned an invalid Automation Toolkit port: ${localPort}`);
    }

    const client = new VegaAutomationClient(vegaBinary, deviceSerial, localPort);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await client.getScreenContext();
        options.onLog?.(`Vega Automation Toolkit ready on localhost:${localPort}`);
        return client;
      } catch (error) {
        if (attempt === 19) {
          await client.close();
          throw error;
        }
        await sleep(250);
      }
    }

    throw new Error("Vega Automation Toolkit did not become ready.");
  }

  async sendInput(action) {
    const inputKeyEvent = INPUT_CODES[action];
    if (inputKeyEvent === undefined) {
      throw new Error(`Action ${action} is not a Vega input event.`);
    }
    await this.#rpc("injectInputKeyEvent", {
      inputKeyEvent: String(inputKeyEvent),
      holdDuration: 100,
    });
  }

  async getScreenContext() {
    const result = await this.#rpc("getScreenContext", {});
    return typeof result === "string" ? JSON.parse(result) : result;
  }

  async takeScreenshot() {
    const result = await this.#rpc("takeScreenshot", {});
    if (typeof result !== "string") {
      throw new Error("Vega takeScreenshot returned a non-string result.");
    }
    return Buffer.from(result, "base64");
  }

  async close() {
    try {
      runVda(this.vegaBinary, [
        "-s",
        this.deviceSerial,
        "forward",
        "--remove",
        `tcp:${this.localPort}`,
      ]);
    } catch {
      // Best-effort cleanup; VDA also removes stale forwards on shutdown.
    }
  }

  async #rpc(method, params) {
    const response = await fetch(`http://127.0.0.1:${this.localPort}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.#requestId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Vega Automation Toolkit HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(
        `Vega Automation Toolkit ${method} failed (${payload.error.code ?? "unknown"}): ${payload.error.message ?? "unknown error"}`
      );
    }
    return payload.result;
  }
}

export function summarizeScreenContext(context) {
  const applications = new Set();
  const visibleText = new Set();
  const focused = [];

  walkContext(context, (node) => {
    const record = asRecord(node);
    const props = asRecord(record.props);
    const traits = asRecord(record.traits);
    const publisher = asRecord(traits.publisherRoot);
    const focusable = asRecord(traits.focusable);
    const visibility = asRecord(traits.visibility);

    if (typeof publisher.applicationName === "string") {
      applications.add(publisher.applicationName);
    }

    const text = normalizeText(props.text);
    for (const item of text) visibleText.add(item);
    if (typeof props.description === "string") visibleText.add(props.description);

    if (focusable.focused === true) {
      focused.push({
        role: typeof props.role === "string" ? props.role : undefined,
        description: typeof props.description === "string" ? props.description : undefined,
        testId: typeof props.test_id === "string" ? props.test_id : undefined,
        text: collectDescendantText(record),
        bounds: visibility.bounds,
      });
    }
  });

  return {
    applications: [...applications],
    focused,
    visibleText: [...visibleText].slice(0, 100),
  };
}

export function resolveVegaBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.VEGA_PATH,
    process.env.HOME ? join(process.env.HOME, "vega", "bin", "vega") : undefined,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "vega");
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error("Vega CLI not found. Install the Vega SDK or pass --vega <path>.");
}

function discoverVegaDevice(vegaBinary) {
  const output = runVda(vegaBinary, ["devices"]);
  const line = output.split("\n").find((candidate) => /\sdevice(?:\s|$)/.test(candidate));
  const serial = line?.trim().split(/\s+/)[0];
  if (!serial) throw new Error("No running Vega VDA device found.");
  return serial;
}

function runVda(vegaBinary, args) {
  try {
    return execFileSync(vegaBinary, ["exec", "vda", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "unknown VDA error").trim();
    throw new Error(`VDA command failed: ${detail}`);
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function walkContext(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkContext(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;

  visitor(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walkContext(child, visitor);
  }
}

function collectDescendantText(node) {
  const text = new Set();
  walkContext(node, (value) => {
    const props = asRecord(asRecord(value).props);
    for (const item of normalizeText(props.text)) text.add(item);
  });
  return [...text];
}

function normalizeText(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((item) => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
