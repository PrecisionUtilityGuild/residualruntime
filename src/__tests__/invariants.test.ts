import test from "node:test";
import assert from "node:assert/strict";
import { step, naiveStep } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";

// ── Structural Invariant Tests ────────────────────────────────────────────────
//
// Four named properties the kernel guarantees. Each has an adversarial trace that
// would falsify a naive (no-residual-check) system but holds under step().

test("P1: no approved action depends on an open tension atom", () => {
  const actionA = { kind: "action" as const, type: "USE_A", dependsOn: ["a=1"] };
  const tension = { type: "Unresolved" as const, phi1: "a=1", phi2: "a=0" };

  const naiveResult = naiveStep({
    state: createInitialState(), residual: createEmptyResidual(),
    input: { constraints: [tension] }, proposals: [actionA],
  });
  assert.equal(naiveResult.actionsApproved.length, 1, "P1 naive: approves despite open tension");

  const enforcing = step({
    state: createInitialState(), residual: createEmptyResidual(),
    input: { constraints: [tension] }, proposals: [actionA],
  });
  assert.equal(enforcing.actionsApproved.length, 0, "P1: runtime blocks action depending on open tension atom");
  assert.equal(enforcing.actionsBlocked.length, 1);

  const passing = step({
    state: createInitialState(), residual: createEmptyResidual(),
    input: {}, proposals: [actionA],
  });
  assert.equal(passing.actionsApproved.length, 1, "P1: action approved when no tension is open");
});

test("P2: no approved action depends on an active evidence gap atom", () => {
  const gap: import("../runtime/model").EvidenceGap = {
    kind: "evidence_gap", phi: "budget_ok", threshold: 0.9, escalationSteps: 99, stepsWithoutEvidence: 0,
  };
  const actionA = { kind: "action" as const, type: "SPEND", dependsOn: ["budget_ok"] };

  let state = createInitialState();
  let residual = createEmptyResidual();
  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  state = s1.stateNext; residual = s1.residualNext;

  assert.ok(residual.evidenceGaps.length > 0, "P2 setup: evidence gap is live in residual");

  const naiveResult = naiveStep({ state, residual, input: {}, proposals: [actionA] });
  assert.equal(naiveResult.actionsApproved.length, 1, "P2 naive: approves despite active evidence gap");

  const enforcing = step({ state, residual, input: {}, proposals: [actionA] });
  assert.equal(enforcing.actionsApproved.length, 0, "P2: runtime blocks action depending on active evidence gap");
  assert.equal(enforcing.actionsBlocked.length, 1);

  const passing = step({
    state: createInitialState(), residual: createEmptyResidual(),
    input: { constraints: [{ type: "RequireEvidence", phi: "budget_ok", threshold: 0.9 }], evidence: { budget_ok: 0.95 } },
    proposals: [actionA],
  });
  assert.equal(passing.actionsApproved.length, 1, "P2: action approved when evidence meets threshold");
});

test("P3: no approved action depends on a rejected atom", () => {
  const actionLoser = { kind: "action" as const, type: "USE_A_FALSE", dependsOn: ["a=false"] };
  const tension = { type: "Unresolved" as const, phi1: "a=true", phi2: "a=false" };

  const s1 = step({
    state: createInitialState(), residual: createEmptyResidual(),
    input: { constraints: [tension] }, proposals: [],
  });
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: { adjudications: [{ phi1: "a=true", phi2: "a=false", winner: "a=true" }] },
    proposals: [],
  });
  assert.ok(s2.stateNext.rejected.includes("a=false"), "P3 setup: a=false is rejected");

  const naiveResult = naiveStep({ state: s2.stateNext, residual: s2.residualNext, input: {}, proposals: [actionLoser] });
  assert.equal(naiveResult.actionsApproved.length, 1, "P3 naive: approves rejected-atom action");

  const enforcing = step({ state: s2.stateNext, residual: s2.residualNext, input: {}, proposals: [actionLoser] });
  assert.equal(enforcing.actionsApproved.length, 0, "P3: action depending on rejected atom is permanently blocked");
  assert.equal(enforcing.actionsBlocked.length, 1);

  const actionWinner = { kind: "action" as const, type: "USE_A_TRUE", dependsOn: ["a=true"] };
  const passing = step({ state: s2.stateNext, residual: s2.residualNext, input: {}, proposals: [actionWinner] });
  assert.equal(passing.actionsApproved.length, 1, "P3: action depending on winning atom is approved");
});

test("P4: adjudication is permanent — re-proposing rejected atom does not reinstate it", () => {
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };
  const actionOnLoser = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };

  const s1 = step({
    state: createInitialState(), residual: createEmptyResidual(),
    input: { constraints: [tension] }, proposals: [],
  });
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
  });
  assert.ok(s2.stateNext.rejected.includes("x=false"), "P4 setup: x=false rejected after adjudication");

  const s3 = step({
    state: s2.stateNext, residual: s2.residualNext,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [actionOnLoser],
  });
  assert.ok(s3.stateNext.rejected.includes("x=false"), "P4: x=false remains in rejected after re-proposal");
  assert.equal(s3.actionsApproved.length, 0, "P4: action on x=false stays blocked — adjudication is permanent");
  assert.equal(s3.actionsBlocked.length, 1);

  const actionOnWinner = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const s4 = step({
    state: s3.stateNext, residual: s3.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionOnWinner],
  });
  assert.equal(s4.actionsApproved.length, 1, "P4: winner-dependent action approved in subsequent steps");
});

// ── AGM Belief Contraction: cascade and minimal-change invariants ──────────────

test("P5: belief contraction cascades — dependent belief is retracted when its only support is the loser", () => {
  // Set up: belief["x=false"] exists, and belief["derived"] is supported by "x=false".
  const state = createInitialState();
  state.belief["x=false"] = 0.9;
  state.beliefSupport["x=false"] = ["x=false"];
  state.belief["derived"] = 0.7;
  state.beliefSupport["derived"] = ["x=false"]; // derived depends solely on x=false

  const residual = createEmptyResidual();

  // Step 1: open tension
  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  // Step 2: adjudicate — x=true wins, x=false contracted
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
  });

  assert.ok(
    s2.stateNext.belief["x=false"] === undefined || s2.stateNext.belief["x=false"] === 0,
    "P5: loser belief retracted"
  );
  assert.ok(
    s2.stateNext.belief["derived"] === undefined || s2.stateNext.belief["derived"] === 0,
    "P5: cascade — derived belief retracted because its only support (x=false) was contracted"
  );
  assert.ok(s2.stateNext.beliefSupport["derived"] === undefined, "P5: support entry for derived is removed");
});

test("P6: belief contraction is minimal — unrelated beliefs survive", () => {
  const state = createInitialState();
  state.belief["x=false"] = 0.9;
  state.beliefSupport["x=false"] = ["x=false"];
  state.belief["unrelated"] = 0.8;
  state.beliefSupport["unrelated"] = ["unrelated"]; // independent support

  const residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
  });

  assert.ok(
    s2.stateNext.belief["x=false"] === undefined || s2.stateNext.belief["x=false"] === 0,
    "P6: loser belief retracted"
  );
  assert.ok(
    (s2.stateNext.belief["unrelated"] ?? 0) > 0,
    "P6: unrelated belief survives contraction (minimal change)"
  );
});

test("P7: belief with multiple supporters survives contraction of one supporter", () => {
  const state = createInitialState();
  state.belief["x=false"] = 0.9;
  state.beliefSupport["x=false"] = ["x=false"];
  state.belief["multi_supported"] = 0.8;
  state.beliefSupport["multi_supported"] = ["x=false", "independent_source"]; // two supporters

  const residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
  });

  assert.ok(
    (s2.stateNext.belief["multi_supported"] ?? 0) > 0,
    "P7: belief with remaining support survives partial contraction"
  );
  // The remaining support entry should only list the surviving supporter
  const remaining = s2.stateNext.beliefSupport["multi_supported"];
  assert.ok(remaining !== undefined && remaining.includes("independent_source"), "P7: remaining support entry preserved");
  assert.ok(!remaining?.includes("x=false"), "P7: retracted supporter removed from support list");
});

// ── M46: State Immutability Invariants ───────────────────────────────────────

test("M46-A: stateNext returned by step() is frozen — top-level property assignment throws", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [],
  });
  assert.throws(
    () => { (result.stateNext as Record<string, unknown>).commitments = []; },
    /Cannot assign to read only property/,
    "M46-A: stateNext.commitments assignment must throw TypeError in test mode"
  );
});

test("M46-B: residualNext returned by step() is frozen — top-level property assignment throws", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [],
  });
  assert.throws(
    () => { (result.residualNext as Record<string, unknown>).tensions = []; },
    /Cannot assign to read only property/,
    "M46-B: residualNext.tensions assignment must throw TypeError in test mode"
  );
});

test("M46-C: two sequential step() calls from the same initial state produce independent objects", () => {
  const state = createInitialState();
  const residual = createEmptyResidual();
  const r1 = step({ state, residual, input: {}, proposals: [] });
  const r2 = step({ state, residual, input: {}, proposals: [] });
  assert.notEqual(r1.stateNext, r2.stateNext, "M46-C: stateNext objects are distinct references");
  assert.notEqual(r1.residualNext, r2.residualNext, "M46-C: residualNext objects are distinct references");
});

// ── M47: AGM Contraction under Auto-Adjudication (TensionTimeoutPolicy) ──────

test("M47-A: auto-adjudication via TensionTimeoutPolicy clears loser belief and cascades to dependent beliefs", () => {
  const state = createInitialState();
  state.belief["x=false"] = 0.9;
  state.beliefSupport["x=false"] = ["x=false"];
  state.belief["derived"] = 0.7;
  state.beliefSupport["derived"] = ["x=false"]; // sole support is the loser

  const residual = createEmptyResidual();

  // Step 1: open the tension with stepsAlive=0
  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  // Step 2: auto-adjudicate immediately (maxSteps=0 fires as soon as stepsAlive >= 0)
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: {
      maxSteps: 0,
      resolve: () => "x=true",
    },
  });

  assert.ok(s2.autoAdjudications.length === 1, "M47-A: one auto-adjudication fired");
  assert.ok(s2.stateNext.rejected.includes("x=false"), "M47-A: loser in rejected");
  assert.ok(
    s2.stateNext.belief["x=false"] === undefined || s2.stateNext.belief["x=false"] === 0,
    "M47-A: loser belief cleared by contractBelief"
  );
  assert.ok(
    s2.stateNext.belief["derived"] === undefined || s2.stateNext.belief["derived"] === 0,
    "M47-A: cascade — derived belief cleared because its only support (x=false) was contracted"
  );
  assert.ok(s2.stateNext.beliefSupport["derived"] === undefined, "M47-A: derived support entry removed");
});

test("M47-B: auto-adjudication belief contraction is minimal — multi-supported belief survives", () => {
  const state = createInitialState();
  state.belief["x=false"] = 0.9;
  state.beliefSupport["x=false"] = ["x=false"];
  state.belief["multi_supported"] = 0.8;
  state.beliefSupport["multi_supported"] = ["x=false", "independent_source"];

  const residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: {
      maxSteps: 0,
      resolve: () => "x=true",
    },
  });

  assert.ok(s2.stateNext.rejected.includes("x=false"), "M47-B: loser rejected");
  assert.ok(
    (s2.stateNext.belief["multi_supported"] ?? 0) > 0,
    "M47-B: multi-supported belief survives — minimal change"
  );
  const remaining = s2.stateNext.beliefSupport["multi_supported"];
  assert.ok(remaining !== undefined && remaining.includes("independent_source"), "M47-B: independent support preserved");
  assert.ok(!remaining?.includes("x=false"), "M47-B: retracted supporter removed from support list");
});

// ── Cross-mechanic correctness audit ─────────────────────────────────────────
//
// The tests below target interaction seams between mechanics added across
// multiple missions. Each is a named invariant that a naive composition of
// the features could violate.

// I1: whatWouldUnblock returns [] when any dep is permanently rejected,
//     even if other deps are resolvable.
//     Rationale: the action can never be approved — no residual change fixes
//     a rejected atom. Surfacing partial deltas would mislead callers.
test("I1: whatWouldUnblock returns [] when action has a rejected dep, even if other deps are tension-blocked", () => {
  const { whatWouldUnblock } = require("../runtime/predicates");

  const state = { ...createInitialState(), rejected: ["x=false"] };
  const residual = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "y=1", phi2: "y=0" }],
  };

  // Action depends on both a rejected atom and a resolvable tension atom.
  const result = whatWouldUnblock(
    { kind: "action", type: "ACT", dependsOn: ["x=false", "y=1"] },
    residual,
    state
  );
  assert.equal(result.permanent, true, "I1: permanently-blocked wins — permanent=true when any dep is rejected");
  assert.deepEqual(result.deltas, [], "I1: no deltas returned when any dep is rejected");
});

// I2: double contractBelief on same loser is idempotent.
//     Scenario: two tensions both list "loser" on one side; auto-adjudication
//     fires on both in the same step (resolves both to the same winner).
test("I2: contractBelief called twice on same loser in one step is idempotent — no phantom belief state", () => {
  const state = createInitialState();
  state.belief["loser"] = 0.8;
  state.beliefSupport["loser"] = ["loser"];
  state.belief["dependent"] = 0.6;
  state.beliefSupport["dependent"] = ["loser"];

  const residual = createEmptyResidual();

  // Two tensions sharing the same loser side
  const s1 = step({
    state, residual,
    input: {
      constraints: [
        { type: "Unresolved", phi1: "winner", phi2: "loser" },
        { type: "Unresolved", phi1: "winner2", phi2: "loser" },
      ],
    },
    proposals: [],
  });

  // Auto-adjudicate both in one step, both naming "loser" as the loser
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: {},
    tensionTimeoutPolicy: {
      maxSteps: 0,
      resolve: (phi1: string, _phi2: string) => phi1, // always pick phi1 (winner/winner2)
    },
    proposals: [],
  });

  assert.equal(s2.autoAdjudications.length, 2, "I2: both tensions auto-adjudicated");
  assert.ok(s2.stateNext.rejected.includes("loser"), "I2: loser is rejected");
  assert.ok(
    s2.stateNext.belief["loser"] === undefined || s2.stateNext.belief["loser"] === 0,
    "I2: loser belief cleared — not doubled or left partially cleared"
  );
  assert.ok(
    s2.stateNext.belief["dependent"] === undefined || s2.stateNext.belief["dependent"] === 0,
    "I2: cascade still fired — dependent belief cleared"
  );
  assert.ok(s2.stateNext.beliefSupport["loser"] === undefined, "I2: loser support entry removed");
  assert.ok(s2.stateNext.beliefSupport["dependent"] === undefined, "I2: dependent support entry removed");
});

// I3: Revocable action is revoked when the atom it depends on becomes
//     permanently rejected via AGM contraction.
//     Rationale: contraction pushes the loser into state.rejected, which
//     makes blocks() return true for any action depending on that atom.
test("I3: revocable action is revoked after AGM contraction rejects its dependency", () => {
  // Step 1: open tension on x=false vs x=true
  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });

  // Step 2: approve a revocable action depending on x=false (while tension is still open,
  // it's blocked — so we need a step where x=false is not yet rejected and not in a tension).
  // Re-start with a clean state where x=false is committed but not rejected.
  const cleanState = createInitialState();
  cleanState.commitments.push({ type: "Prop", phi: "x=false" });
  cleanState.belief["x=false"] = 0.9;
  cleanState.beliefSupport["x=false"] = ["x=false"];

  const revocable = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"], revocable: true as const };

  const sRevoke = step({
    state: cleanState,
    residual: createEmptyResidual(),
    input: {},
    proposals: [revocable],
  });
  assert.equal(sRevoke.actionsApproved.length, 1, "I3 setup: revocable action approved while x=false is clean");
  const emitted = sRevoke.emittedRevocable;
  assert.equal(emitted.length, 1, "I3 setup: action is in emittedRevocable");

  // Step 3: tension enters residual (stepsAlive=0 after discharge, not enough for timeout yet)
  const s3 = step({
    state: sRevoke.stateNext,
    residual: sRevoke.residualNext,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
    tensionTimeoutPolicy: { maxSteps: 1, resolve: () => "x=true" },
    priorRevocable: emitted,
  });
  assert.equal(s3.residualNext.tensions.length, 1, "I3 step 3: tension in residual");

  // Step 4: tension has stepsAlive=1 in residualPre — timeout fires, x=false rejected
  const s4 = step({
    state: s3.stateNext,
    residual: s3.residualNext,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: { maxSteps: 1, resolve: () => "x=true" },
    priorRevocable: emitted,
  });

  assert.ok(s4.stateNext.rejected.includes("x=false"), "I3: x=false rejected after auto-adjudication");
  assert.equal(s4.revokedActions.length, 1, "I3: revocable action appears in revokedActions after x=false is rejected");
  assert.equal(s4.revokedActions[0].type, "USE_X_FALSE");
});

// I4: gapCounters is not left stale after a gap escalates to deferred and
//     the deferred subsequently discharges.
test("I4: gapCounters cleared when gap escalates then deferred discharges — no phantom counter", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  // Gap with escalationSteps=2 so it promotes quickly
  const gap = {
    kind: "evidence_gap" as const,
    phi: "sensor_ok",
    threshold: 0.9,
    escalationSteps: 2,
  };

  // Step 1: gap enters residual
  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: dischargeEvidenceGaps increments counter to 1, gap still present
  const s2 = step({ state, residual, input: {} });
  assert.equal(s2.stateNext.gapCounters["sensor_ok"], 1, "I4 step 2: counter=1");
  state = s2.stateNext; residual = s2.residualNext;

  // Step 3: stepsWithoutEvidence reaches 2 >= escalationSteps=2 → gap promoted to deferred, counter cleared
  const s3 = step({ state, residual, input: {} });
  assert.equal(s3.residualNext.evidenceGaps.length, 0, "I4 step 3: gap promoted, no longer in evidenceGaps");
  assert.equal(s3.residualNext.deferred.length, 1, "I4 step 3: deferred entered residual");
  assert.equal(s3.stateNext.gapCounters["sensor_ok"], undefined, "I4 step 3: counter cleared on promotion");
  state = s3.stateNext; residual = s3.residualNext;

  // Step 4: evidence arrives, deferred discharges
  const s4 = step({ state, residual, input: { evidence: { sensor_ok: 0.95 } } });
  assert.equal(s4.residualNext.deferred.length, 0, "I4 step 4: deferred discharged after evidence");
  assert.equal(s4.stateNext.gapCounters["sensor_ok"], undefined, "I4 step 4: no phantom counter after deferred discharges");
});

// I5: sufficient=true delta on a multi-dependency action — verify that applying
//     the delta actually makes blocks() return false when there is only one blocker.
//     This is the simulation soundness check: the in-memory simulation must agree
//     with what a real step() would produce.
test("I5: whatWouldUnblock sufficient=true delta actually unblocks the action in a real step()", () => {
  const { whatWouldUnblock } = require("../runtime/predicates");

  // Single evidence gap blocks the action
  const residual = {
    ...createEmptyResidual(),
    evidenceGaps: [{ kind: "evidence_gap" as const, phi: "budget_ok", threshold: 0.8 }],
  };
  const state = createInitialState();
  const action = { kind: "action" as const, type: "PAY", dependsOn: ["budget_ok"] };

  const analysis = whatWouldUnblock(action, residual, state);
  assert.equal(analysis.permanent, false);
  assert.equal(analysis.deltas.length, 1);
  assert.equal(analysis.deltas[0].sufficient, true, "I5: sole gap delta is sufficient");

  // Now apply the delta for real: provide evidence to meet threshold
  const result = step({
    state,
    residual,
    input: { evidence: { budget_ok: 0.85 } },
    proposals: [action],
  });
  assert.equal(result.actionsApproved.length, 1, "I5: real step confirms action is unblocked after applying the sufficient delta");
  assert.equal(result.actionsBlocked.length, 0);
});

// I6: two tensions sharing the same winner auto-adjudicated in one step must not
//     produce a duplicate Prop commitment for that winner in statePre.commitments.
test("I6: two tensions sharing the same winner produce exactly one Prop commitment for that winner", () => {
  const state = createInitialState();
  const residual = createEmptyResidual();

  // Introduce two tensions both resolved by the same winner atom
  const s1 = step({
    state, residual,
    input: {
      constraints: [
        { type: "Unresolved", phi1: "winner", phi2: "loser_a" },
        { type: "Unresolved", phi1: "winner", phi2: "loser_b" },
      ],
    },
    proposals: [],
  });

  // Auto-adjudicate both in one step — policy always picks phi1 (winner)
  const s2 = step({
    state: s1.stateNext, residual: s1.residualNext,
    input: {},
    tensionTimeoutPolicy: { maxSteps: 0, resolve: (phi1: string) => phi1 },
    proposals: [],
  });

  assert.equal(s2.autoAdjudications.length, 2, "I6: both tensions auto-adjudicated");

  const winnerCommitments = s2.stateNext.commitments.filter(
    (c) => c.type === "Prop" && c.phi === "winner"
  );
  assert.equal(winnerCommitments.length, 1, "I6: exactly one Prop commitment for the shared winner — no duplicates");
});
