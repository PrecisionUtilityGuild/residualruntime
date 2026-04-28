#!/usr/bin/env node

import { resolve } from "node:path";
import { SessionManager } from "./sessions";

function parseArgs(argv: string[]): { rootDir?: string; help: boolean } {
  let rootDir: string | undefined = undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--root" && i + 1 < argv.length) {
      rootDir = resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { rootDir, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: node dist/mcp/migrate.js [--root <session-dir>]",
      "",
      "Imports legacy per-session *.ndjson logs into sessions.sqlite.",
      "If --root is omitted, SessionManager default root resolution is used.",
      "",
    ].join("\n")
  );
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }

  const manager = new SessionManager(parsed.rootDir);
  const result = manager.importLegacyNdjsonSessions();

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Legacy NDJSON migration failed: ${message}\n`);
  process.exit(1);
}
