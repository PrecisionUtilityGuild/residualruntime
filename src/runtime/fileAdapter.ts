import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ReplayEvent } from "./model";
import type { StepLogAdapter } from "./store";

class FileStepLog implements StepLogAdapter {
  constructor(private readonly path: string) {
    if (!existsSync(path)) writeFileSync(path, "", "utf8");
  }

  append(event: ReplayEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  readAll(): ReplayEvent[] {
    const raw = readFileSync(this.path, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as ReplayEvent);
  }
}

export function createFileLog(path: string): StepLogAdapter {
  return new FileStepLog(path);
}
