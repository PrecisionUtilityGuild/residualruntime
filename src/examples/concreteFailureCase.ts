import {
  createEmptyResidual,
  createInitialState,
  createInMemoryLog,
  appendStep,
  step,
  naiveStep,
  diffStep,
  summarizeTrace,
  type ReplayEvent,
  type StepResult,
} from "../index";

function formatActionTypes(actions: StepResult["actionsApproved"]): string {
  return actions.length === 0 ? "(none)" : actions.map((action) => action.type).join(", ");
}

function formatResidual(result: StepResult): string {
  const { tensions, evidenceGaps, deferred, assumptions } = result.residualNext;
  return `tensions=${tensions.length}, evidenceGaps=${evidenceGaps.length}, deferred=${deferred.length}, assumptions=${assumptions.length}`;
}

function printResult(label: string, result: StepResult): void {
  console.log(`\n${label}`);
  console.log(`  approved: ${formatActionTypes(result.actionsApproved)}`);
  console.log(`  blocked: ${formatActionTypes(result.actionsBlocked)}`);
  console.log(`  rejected atoms: ${result.stateNext.rejected.join(", ") || "(none)"}`);
  console.log(`  residual: ${formatResidual(result)}`);
}

function printDiff(label: string, before: ReplayEvent, after: ReplayEvent): void {
  const diff = diffStep(before, after);
  const removed = diff.tensionsRemoved.map((tension) => `${tension.phi1}|${tension.phi2}`).join(", ") || "(none)";
  const approved = diff.actionsApproved.map((action) => action.type).join(", ") || "(none)";
  const blocked = diff.actionsBlocked.map((action) => action.type).join(", ") || "(none)";

  console.log(`\n${label}`);
  console.log(`  tensions removed: ${removed}`);
  console.log(`  actions approved in later step: ${approved}`);
  console.log(`  actions blocked in later step: ${blocked}`);
}

function main(): void {
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  console.log("Residual Runtime: concrete failure case");
  console.log("This trace compares naive execution with the enforcing runtime.");

  const naive = naiveStep({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [tension] },
    proposals: [actionA],
  });
  printResult("Naive step 1: dispute open, action depending on x=true is still approved", naive);

  const log = createInMemoryLog();

  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [tension] },
    proposals: [actionA],
  });
  appendStep(log, s1.replay);
  printResult("Runtime step 1: same proposal is blocked while the tension is live", s1);

  const s2 = step({
    state: s1.stateNext,
    residual: s1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionA],
  });
  appendStep(log, s2.replay);
  printResult("Runtime step 2: adjudication discharges the tension and action becomes admissible", s2);

  const s3 = step({
    state: s2.stateNext,
    residual: s2.residualNext,
    input: {},
    proposals: [actionB],
  });
  appendStep(log, s3.replay);
  printResult("Runtime step 3: the losing branch returns and is permanently blocked", s3);

  printDiff("Diff from runtime step 1 -> step 2", s1.replay, s2.replay);
  printDiff("Diff from runtime step 2 -> step 3", s2.replay, s3.replay);

  console.log("\nReplay summary");
  console.log(summarizeTrace(log.readAll()));
}

main();
