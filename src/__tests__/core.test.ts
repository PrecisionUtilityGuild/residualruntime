import test from "node:test";
import assert from "node:assert/strict";
import { step, naiveStep } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { appendStep, createInMemoryLog, replayLog } from "../runtime/store";
import { type TransitionEngine } from "../runtime/transition";

test("blocks action when evidence is below threshold", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      evidence: { approved_budget: 0.4 },
      constraints: [{ type: "RequireEvidence", phi: "approved_budget", threshold: 0.8 }],
    },
    proposals: [{ kind: "action", type: "EXECUTE_PAYMENT", dependsOn: ["approved_budget"] }],
  });

  assert.equal(result.actionsApproved.length, 0);
  assert.equal(result.actionsBlocked.length, 1);
});

test("unblocks action after evidence and adjudication", () => {
  const step1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "Unresolved", phi1: "ship_fast", phi2: "full_review" }],
      evidence: { approved_budget: 0.2 },
    },
    proposals: [{ kind: "action", type: "EXECUTE_PAYMENT", dependsOn: ["ship_fast"] }],
  });

  const step2 = step({
    state: step1.stateNext,
    residual: step1.residualNext,
    input: {
      evidence: { approved_budget: 0.9 },
      adjudications: [{ phi1: "ship_fast", phi2: "full_review", winner: "full_review" }],
    },
    proposals: [{ kind: "action", type: "EXECUTE_PAYMENT", dependsOn: ["approved_budget"] }],
  });

  assert.equal(step2.actionsApproved.length, 1);
  assert.equal(step2.actionsBlocked.length, 0);
  assert.ok(step2.replay.constraints.length >= 0);
});

/*
 * Concrete failure case: naive systems act, ours blocks.
 *
 * Scenario: a disputed atom "x=true" vs "x=false".
 * Action A depends on "x=true" — it must not fire while the dispute is open.
 * Action B depends on "x=false" — it must be permanently blocked after "x=true" wins.
 *
 * Step 1 — dispute is open:
 *   Naive runner: approves A immediately (no residual checking).
 *   Residual Runtime: blocks A because an Unresolved tension exists on x=true/x=false.
 *
 * Step 2 — adjudication resolves in favour of x=true:
 *   Residual Runtime: tension cleared, x=true committed, x=false rejected.
 *   A is now unblocked and approved.
 *
 * Step 3 — action B arrives depending on the losing side:
 *   Residual Runtime: permanently blocks B because x=false is in state.rejected.
 *
 * This proves the runtime's value: naive systems fire actions that depend on
 * unresolved tensions, causing split-brain outcomes. The runtime enforces
 * adjudication-gated execution and permanently forecloses losing branches.
 */
test("concrete failure case: naive system acts, runtime blocks, then unblocks after adjudication, then permanently blocks loser", () => {
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  // ── Step 1: dispute open ─────────────────────────────────────────────────
  const naiveStep1 = naiveStep({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [tension] },
    proposals: [actionA],
  });

  const runtimeStep1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [tension] },
    proposals: [actionA],
  });

  assert.equal(naiveStep1.actionsApproved.length, 1, "naive: approves A while tension is open");
  assert.equal(naiveStep1.actionsBlocked.length, 0);
  assert.equal(runtimeStep1.actionsApproved.length, 0, "runtime: blocks A while tension is open");
  assert.equal(runtimeStep1.actionsBlocked.length, 1);
  assert.equal(runtimeStep1.actionsBlocked[0].type, "USE_X_TRUE");

  // ── Step 2: adjudication — x=true wins ──────────────────────────────────
  const runtimeStep2 = step({
    state: runtimeStep1.stateNext,
    residual: runtimeStep1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionA],
  });

  assert.equal(runtimeStep2.actionsApproved.length, 1, "runtime: approves A after x=true wins adjudication");
  assert.equal(runtimeStep2.actionsBlocked.length, 0);
  assert.equal(runtimeStep2.actionsApproved[0].type, "USE_X_TRUE");
  assert.ok(runtimeStep2.stateNext.rejected.includes("x=false"), "x=false is recorded as rejected");

  // ── Step 3: action B arrives depending on the losing side ────────────────
  const runtimeStep3 = step({
    state: runtimeStep2.stateNext,
    residual: runtimeStep2.residualNext,
    input: {},
    proposals: [actionB],
  });

  assert.equal(runtimeStep3.actionsApproved.length, 0, "runtime: permanently blocks B depending on x=false");
  assert.equal(runtimeStep3.actionsBlocked.length, 1);
  assert.equal(runtimeStep3.actionsBlocked[0].type, "USE_X_FALSE");
});

test("replay: stored log reproduces concrete failure case", () => {
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  const log = createInMemoryLog();
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [actionA] });
  appendStep(log, s1.replay);
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionA],
  });
  appendStep(log, s2.replay);
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [actionB] });
  appendStep(log, s3.replay);

  const originals = [s1, s2, s3];
  const proposalSets = [[actionA], [actionA], [actionB]];
  const replayed = replayLog(log, createInitialState(), createEmptyResidual(), proposalSets);

  for (let i = 0; i < 3; i++) {
    assert.deepEqual(
      replayed[i].actionsApproved.map((a) => a.type).sort(),
      originals[i].actionsApproved.map((a) => a.type).sort(),
      `step ${i + 1}: actionsApproved match`
    );
    assert.deepEqual(
      replayed[i].actionsBlocked.map((a) => a.type).sort(),
      originals[i].actionsBlocked.map((a) => a.type).sort(),
      `step ${i + 1}: actionsBlocked match`
    );
  }
});

test("custom TransitionEngine: injected engine controls candidate actions", () => {
  const fixedAction = { kind: "action" as const, type: "FIXED_ACTION", dependsOn: [] };
  const customEngine: TransitionEngine = {
    run(_statePre, _constraints, _proposals, _residualPre) {
      const { createEmptyResidual: mkResidual } = require("../runtime/model");
      return { stateNext: _statePre, actionsCandidate: [fixedAction], residualNew: mkResidual() };
    },
  };

  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [{ kind: "action" as const, type: "IGNORED_ACTION" }],
    transitionEngine: customEngine,
  });

  assert.equal(result.actionsApproved.length, 1, "custom engine's action is approved");
  assert.equal(result.actionsApproved[0].type, "FIXED_ACTION");
  assert.ok(!result.actionsApproved.some((a) => a.type === "IGNORED_ACTION"));
});
