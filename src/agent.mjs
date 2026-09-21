import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const STDERR_LIMIT = 4096;

export function resolveClaudeBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CLAUDE_PATH,
    process.env.HOME ? join(process.env.HOME, ".toolbox", "bin", "claude") : undefined,
    process.env.HOME ? join(process.env.HOME, ".local", "bin", "claude") : undefined,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "claude");
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error("Claude CLI not found. Install Claude Code or pass --claude <path>.");
}

export function invokeClaude(prompt, options = {}) {
  const claudeBinary = resolveClaudeBinary(options.claudePath);
  const args = [
    "-p",
    "-",
    "--allowedTools",
    "Read",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (options.model) args.push("--model", options.model);

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let text = "";
    let tokens = 0;
    let costUsd = 0;

    const consumeLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type !== "result") return;
        text = event.result ?? "";
        const usage = event.usage ?? {};
        tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        costUsd = event.total_cost_usd ?? 0;
      } catch {
        // Ignore non-JSON diagnostic lines.
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString();
    });

    child.stdin.end(prompt);

    const timeoutMs = options.timeoutMs ?? 180_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) consumeLine(stdout);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with ${code}: ${stderr.slice(0, STDERR_LIMIT)}`));
        return;
      }
      if (!text.trim()) {
        reject(new Error("Claude CLI returned no result text."));
        return;
      }
      resolve({ text, tokens, costUsd });
    });
  });
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
