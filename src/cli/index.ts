import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import ollama, { type Message } from "ollama";
import { step, whatWouldUnblock, createEmptyResidual, createInitialState } from "../index";
import { createFileLog } from "../runtime/fileAdapter";
import { appendStep } from "../runtime/store";
import type { State, Residual, Input, Action } from "../runtime/model";
import { SYSTEM_PROMPT, INITIAL_PROPOSALS, INITIAL_INPUT } from "./scenario";

const LOG_PATH = ".residual-cli.ndjson";

// Extract all top-level JSON objects from a text response using brace-depth
// tracking. The non-greedy regex approach fails on nested objects.
function extractToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    const candidate = text.slice(start, end + 1);
    try {
      const obj = JSON.parse(candidate);
      if (typeof obj.name === "string" && (obj.arguments || obj.parameters || obj.args)) {
        const args = (obj.arguments ?? obj.parameters ?? obj.args) as Record<string, unknown>;
        calls.push({ name: obj.name, args });
      }
    } catch {
      // not valid JSON
    }
    i = end + 1;
  }
  return calls;
}

function formatBlockedResult(action: Action, residual: Residual, state: State): string {
  const analysis = whatWouldUnblock(action, residual, state);

  if (analysis.permanent) {
    return JSON.stringify({
      status: "PERMANENTLY_BLOCKED",
      reason: "One or more dependencies are in state.rejected — no residual change can fix this.",
    });
  }

  return JSON.stringify({
    status: "BLOCKED",
    whatWouldUnblock: analysis.deltas,
    sufficientSingleFixes: analysis.deltas.filter((d) => d.sufficient),
  }, null, 2);
}

function formatApprovedResult(): string {
  return JSON.stringify({ status: "APPROVED", message: "Action approved and executed." });
}

function formatInputResult(result: ReturnType<typeof step>): string {
  const tensions = result.residualNext.tensions.map((t) => `${t.phi1} vs ${t.phi2}`);
  const gaps = result.residualNext.evidenceGaps.map(
    (g) => `${g.phi} (need ≥${g.threshold}, stepsWithoutEvidence=${g.stepsWithoutEvidence ?? 0})`
  );
  const deferred = result.residualNext.deferred.map((d) => {
    const c = d.constraint;
    const phi = c.type === "Unresolved" ? `${c.phi1}/${c.phi2}` : c.phi;
    return `${phi} (waiting on: ${d.dependencies.join(", ")})`;
  });

  return JSON.stringify({
    status: "INPUT_ACCEPTED",
    residualSummary: { openTensions: tensions, evidenceGaps: gaps, deferred },
  }, null, 2);
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const log = createFileLog(LOG_PATH);
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];

  let state: State = createInitialState();
  let residual: Residual = createEmptyResidual();

  const seed = step({ state, residual, input: INITIAL_INPUT, proposals: INITIAL_PROPOSALS });
  state = seed.stateNext;
  residual = seed.residualNext;
  appendStep(log, seed.replay);

  console.log("\n=== Residual Runtime CLI ===");
  console.log("Scenario: deploy a service to production.");
  console.log("The runtime has seeded the following blocking conditions:");
  console.log(`  Tension:     tests=passing  vs  tests=failing`);
  console.log(`  EvidenceGap: security_scan  (need belief ≥ 0.8)`);
  console.log(`  Deferred:    staging_approved  (waiting on lead_review=done)`);
  console.log("\nTalk to the junior dev. They'll try to deploy. Help them resolve the blocks.\n");

  const firstUserMsg = await rl.question("You: ");
  messages.push({ role: "user", content: firstUserMsg });

  let consecutiveToolRounds = 0;
  let done = false;

  while (!done) {
    const response = await ollama.chat({ model: "llama3.1:8b", messages });
    const msg = response.message;
    const text = msg.content ?? "";
    messages.push(msg);

    const toolCalls = extractToolCalls(text);

    if (toolCalls.length === 0) {
      // Pure text response — print and ask user
      consecutiveToolRounds = 0;
      if (text) console.log(`\nDev: ${text}\n`);
      const userInput = await rl.question("You: ");
      if (userInput.toLowerCase() === "exit") break;
      messages.push({ role: "user", content: userInput });
      continue;
    }

    // Has tool calls — print any surrounding prose first
    const prose = text.replace(/\{[\s\S]*\}/g, "").trim();
    if (prose) console.log(`\nDev: ${prose}\n`);

    consecutiveToolRounds++;
    if (consecutiveToolRounds >= 6) {
      messages.push({ role: "user", content: "Stop calling tools. Summarize what you need from me in plain text." });
      consecutiveToolRounds = 0;
      continue;
    }

    let toolResults = "";
    let approved = false;

    for (const { name, args } of toolCalls) {
      if (name === "propose_action") {
        if (!args.type || typeof args.type !== "string") {
          toolResults += `TOOL propose_action ERROR: missing required field 'type'.\n`;
          continue;
        }
        const action: Action = {
          kind: "action",
          type: args.type,
          dependsOn: Array.isArray(args.dependsOn) ? (args.dependsOn as string[]) : [],
        };

        const result = step({ state, residual, input: {}, proposals: [action] });
        state = result.stateNext;
        residual = result.residualNext;
        appendStep(log, result.replay);

        const isApproved = result.actionsApproved.some((a) => a.type === action.type);
        if (isApproved) {
          console.log(`\n[ENGINE] ✓ ${action.type} APPROVED\n`);
          toolResults += `TOOL propose_action RESULT: ${formatApprovedResult()}\n`;
          approved = true;
        } else {
          console.log(`\n[ENGINE] ✗ ${action.type} BLOCKED\n`);
          toolResults += `TOOL propose_action RESULT: ${formatBlockedResult(action, residual, state)}\n`;
        }

      } else if (name === "submit_input") {
        const input: Input = {};
        if (args.evidence && typeof args.evidence === "object") {
          input.evidence = args.evidence as Record<string, number>;
        }
        if (Array.isArray(args.adjudications)) {
          input.adjudications = args.adjudications as Input["adjudications"];
        }
        if (Array.isArray(args.commitments) && args.commitments.length > 0) {
          input.constraints = (args.commitments as string[]).map((phi) => ({ type: "Prop" as const, phi }));
        }

        const result = step({ state, residual, input, proposals: [] });
        state = result.stateNext;
        residual = result.residualNext;
        appendStep(log, result.replay);

        console.log(`\n[ENGINE] Input accepted\n`);
        toolResults += `TOOL submit_input RESULT: ${formatInputResult(result)}\n`;
      }
    }

    messages.push({ role: "user", content: toolResults.trim() });

    if (approved) {
      // Let model say one more thing, then exit
      const finalResp = await ollama.chat({ model: "llama3.1:8b", messages });
      const finalText = finalResp.message.content ?? "";
      if (finalText) console.log(`\nDev: ${finalText}\n`);
      done = true;
    }
  }

  rl.close();
  console.log(`\nSession log saved to ${LOG_PATH}`);
}

main().catch(console.error);
