import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";

test("escalates EvidenceGap after escalationSteps exceeded", () => {
  const gap = {
    kind: "evidence_gap" as const,
    phi: "budget_approved",
    threshold: 0.8,
    escalationSteps: 2,
    stepsWithoutEvidence: 0,
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  assert.deepEqual(s1.escalations, [], "step 1: no escalation yet");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: {}, proposals: [] });
  assert.deepEqual(s2.escalations, [], "step 2: still no escalation");
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s3.escalations.length, 1, "step 3: escalation triggered");
  assert.equal(s3.escalations[0].phi, "budget_approved");
  assert.equal(s3.escalations[0].threshold, 0.8);
});

test("overflow: tensions exceed maxTensions limit", () => {
  const tensions = [
    { kind: "tension" as const, phi1: "a=1", phi2: "a=0" },
    { kind: "tension" as const, phi1: "b=1", phi2: "b=0" },
    { kind: "tension" as const, phi1: "c=1", phi2: "c=0" },
  ];

  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: tensions,
    residualLimits: { maxTensions: 2 },
  });

  assert.equal(result.overflows.length, 1, "overflow is surfaced");
  assert.equal(result.overflows[0].field, "tensions");
  assert.equal(result.overflows[0].count, 3);
  assert.equal(result.overflows[0].limit, 2);
  assert.equal(result.residualNext.tensions.length, 3, "overflow does not truncate residual");
});

test("overflow: no overflow when within limits", () => {
  const tensions = [
    { kind: "tension" as const, phi1: "a=1", phi2: "a=0" },
    { kind: "tension" as const, phi1: "b=1", phi2: "b=0" },
    { kind: "tension" as const, phi1: "c=1", phi2: "c=0" },
  ];

  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: tensions,
    residualLimits: { maxTensions: 5 },
  });

  assert.deepEqual(result.overflows, []);
});

test("TensionTimeoutPolicy: auto-adjudicates tension at TTL", () => {
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const policy = { maxSteps: 2, resolve: () => "x=true" };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [actionA], tensionTimeoutPolicy: policy });
  assert.equal(s1.actionsApproved.length, 0, "step 1: actionA blocked (tension open)");
  assert.equal(s1.autoAdjudications.length, 0, "step 1: no auto-adjudication yet");
  assert.ok((s1.residualNext.tensions[0].stepsAlive ?? 0) === 0, "step 1: stepsAlive=0 on introduction");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: {}, proposals: [actionA], tensionTimeoutPolicy: policy });
  assert.equal(s2.autoAdjudications.length, 0, "step 2: no auto-adjudication yet (stepsAlive=1)");
  assert.equal(s2.actionsApproved.length, 0, "step 2: actionA still blocked");
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [actionA], tensionTimeoutPolicy: policy });
  assert.equal(s3.autoAdjudications.length, 1, "step 3: auto-adjudication fired");
  assert.deepEqual(s3.autoAdjudications[0], { phi1: "x=true", phi2: "x=false", winner: "x=true" });
  assert.equal(s3.actionsApproved.length, 1, "step 3: actionA approved after auto-adjudication");
  assert.equal(s3.actionsApproved[0].type, "USE_X_TRUE");
  assert.ok(s3.stateNext.rejected.includes("x=false"), "step 3: x=false is rejected");
});

test("deadlock detection: tension unresolved for > threshold steps", () => {
  const tension = { type: "Unresolved" as const, phi1: "a=1", phi2: "a=0" };
  let state = createInitialState();
  let residual = createEmptyResidual();

  let last = step({ state, residual, input: { constraints: [tension] }, deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 0, "step 1: no deadlock yet");
  state = last.stateNext; residual = last.residualNext;

  for (let i = 2; i <= 10; i++) {
    last = step({ state, residual, input: {}, deadlockThreshold: 10 });
    state = last.stateNext; residual = last.residualNext;
  }
  assert.equal(last.deadlocks.length, 0, "step 10: stepsAlive=9, not yet at threshold");

  last = step({ state, residual, input: {}, deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 1, "step 11: deadlock fires at stepsAlive=10");
  assert.equal(last.deadlocks[0].itemKind, "tension");
  assert.equal(last.deadlocks[0].stepsStuck, 10);
});

test("deadlock detection: deferred dependency stuck for > threshold steps", () => {
  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "gate=open" },
    dependencies: ["evidence:never-satisfied"],
  };
  let state = createInitialState();
  let residual = createEmptyResidual();

  let last = step({ state, residual, input: {}, proposals: [deferred], deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 0, "step 1: no deadlock yet");
  state = last.stateNext; residual = last.residualNext;

  for (let i = 2; i <= 10; i++) {
    last = step({ state, residual, input: {}, deadlockThreshold: 10 });
    state = last.stateNext; residual = last.residualNext;
  }
  assert.equal(last.deadlocks.length, 0, "step 10: stepsStuck=9, not yet at threshold");

  last = step({ state, residual, input: {}, deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 1, "step 11: deadlock fires at stepsStuck=10");
  assert.equal(last.deadlocks[0].itemKind, "deferred");
  assert.equal(last.deadlocks[0].stepsStuck, 10);
});

test("oscillation detection: two-step cycle produces OscillationEvent", () => {
  const tension = { type: "Unresolved" as const, phi1: "a=1", phi2: "a=0" };
  let state = createInitialState();
  let residual = createEmptyResidual();
  let history: string[] = [];

  const s1 = step({ state, residual, input: { constraints: [tension] }, fingerprintHistory: history });
  assert.equal(s1.oscillations.length, 0, "step 1: no oscillation (no prior history)");
  state = s1.stateNext; residual = s1.residualNext; history = s1.fingerprintHistory;

  const s2 = step({ state, residual, input: {}, fingerprintHistory: history });
  assert.equal(s2.oscillations.length, 1, "step 2: oscillation detected — same fingerprint recurs");
  assert.equal(s2.oscillations[0].cycleLength, 1);
  assert.ok(s2.oscillations[0].fingerprint.length > 0);
});

test("oscillation detection: non-repeating residual produces no OscillationEvent", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();
  let history: string[] = [];

  const tensions = [
    { type: "Unresolved" as const, phi1: "a=1", phi2: "a=0" },
    { type: "Unresolved" as const, phi1: "b=1", phi2: "b=0" },
    { type: "Unresolved" as const, phi1: "c=1", phi2: "c=0" },
  ];

  for (let i = 0; i < tensions.length; i++) {
    const si = step({
      state,
      residual: createEmptyResidual(),
      input: { constraints: [tensions[i]] },
      fingerprintHistory: history,
    });
    assert.equal(si.oscillations.length, 0, `step ${i + 1}: no oscillation with unique fingerprint`);
    state = si.stateNext;
    history = si.fingerprintHistory;
  }
});

test("soft blocking: action with unmet Prefer is approved and softBlocked", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Prefer", phi: "fast_path", weight: 0.8 }] },
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["fast_path"] }],
  });

  assert.equal(result.actionsApproved.length, 1, "action is approved (Prefer does not hard-block)");
  assert.equal(result.actionsBlocked.length, 0);
  assert.equal(result.softBlocked.length, 1, "action is softBlocked due to unmet preference");
  assert.equal(result.softBlocked[0].action.type, "DEPLOY");
  assert.equal(result.softBlocked[0].unmetPreferences.length, 1);
  assert.equal(result.softBlocked[0].unmetPreferences[0].phi, "fast_path");
});

test("soft blocking: action not softBlocked when Prefer constraint phi not in dependsOn", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Prefer", phi: "fast_path", weight: 0.8 }] },
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["other_atom"] }],
  });

  assert.equal(result.actionsApproved.length, 1, "action approved");
  assert.equal(result.softBlocked.length, 0, "not softBlocked — dependsOn does not reference fast_path");
});

test("causal annotation: blockedWith identifies the blocking atom", () => {
  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
  });

  assert.equal(s1.actionsBlocked.length, 1, "action blocked");
  assert.equal(s1.blockedWith.length, 1, "blockedWith has one entry");
  assert.equal(s1.blockedWith[0].action.type, "USE_X_TRUE");
  assert.ok(s1.blockedWith[0].blockedBy.includes("x=true"), "blockedBy names the contested atom");
});

// ── Mission 40: Fingerprint completeness ─────────────────────────────────────

test("fingerprint: two residuals with same tensions/gaps but different deferred produce distinct fingerprints", () => {
  const { computeFingerprint } = require("../runtime/policies");
  const { createEmptyResidual } = require("../runtime/model");

  const base = createEmptyResidual();
  base.tensions.push({ kind: "tension", phi1: "a", phi2: "b" });

  const withDeferred = createEmptyResidual();
  withDeferred.tensions.push({ kind: "tension", phi1: "a", phi2: "b" });
  withDeferred.deferred.push({
    kind: "deferred",
    constraint: { type: "Prop", phi: "gate=open" },
    dependencies: ["approval"],
  });

  assert.notEqual(
    computeFingerprint(base),
    computeFingerprint(withDeferred),
    "deferred item changes the fingerprint"
  );
});

test("fingerprint: two residuals with same tensions/gaps but different assumptions produce distinct fingerprints", () => {
  const { computeFingerprint } = require("../runtime/policies");
  const { createEmptyResidual } = require("../runtime/model");

  const base = createEmptyResidual();
  base.evidenceGaps.push({ kind: "evidence_gap", phi: "sensor=ok", threshold: 0.8 });

  const withAssumption = createEmptyResidual();
  withAssumption.evidenceGaps.push({ kind: "evidence_gap", phi: "sensor=ok", threshold: 0.8 });
  withAssumption.assumptions.push({ kind: "assumption", phi: "fast_path", weight: 0.9 });

  assert.notEqual(
    computeFingerprint(base),
    computeFingerprint(withAssumption),
    "assumption changes the fingerprint"
  );
});

test("fingerprint: oscillation detected when deferred+assumption composition repeats", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();
  let history: string[] = [];

  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "gate=open" },
    dependencies: ["evidence:never"],
  };

  // Step 1: deferred enters residual (via proposal)
  const s1 = step({ state, residual, input: {}, proposals: [deferred], fingerprintHistory: history });
  assert.equal(s1.oscillations.length, 0, "step 1: no oscillation yet");
  state = s1.stateNext; residual = s1.residualNext; history = s1.fingerprintHistory;

  // Step 2: same deferred stays stuck — same fingerprint as step 1 → oscillation
  const s2 = step({ state, residual, input: {}, proposals: [], fingerprintHistory: history });
  assert.equal(s2.oscillations.length, 1, "step 2: oscillation detected on repeating deferred-only fingerprint");
  assert.ok(s2.oscillations[0].fingerprint.includes("D:Prop:gate=open"), "fingerprint includes deferred identity");
});

test("causal annotation: approvedWith.enabledBy identifies the winning adjudication", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
  });

  assert.equal(s2.actionsApproved.length, 1, "action approved after adjudication");
  assert.equal(s2.approvedWith.length, 1, "approvedWith has one entry");
  assert.equal(s2.approvedWith[0].action.type, "USE_X_TRUE");
  assert.ok(s2.approvedWith[0].enabledBy.includes("x=true"), "enabledBy names the winner atom");
});

// ── Mission 51: Evidence Gap Deadlock Detection ──────────────────────────────

test("deadlock detection: evidence gap stuck for >= threshold steps emits DeadlockEvent", () => {
  const gap = {
    kind: "evidence_gap" as const,
    phi: "sensor_ok",
    threshold: 0.9,
    escalationSteps: 999,
  };
  let state = createInitialState();
  let residual = createEmptyResidual();

  let last = step({ state, residual, input: {}, proposals: [gap], deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 0, "step 1: no deadlock yet");
  state = last.stateNext; residual = last.residualNext;

  for (let i = 2; i <= 10; i++) {
    last = step({ state, residual, input: {}, deadlockThreshold: 10 });
    state = last.stateNext; residual = last.residualNext;
  }
  assert.equal(last.deadlocks.length, 0, "step 10: stepsWithoutEvidence=9, not yet at threshold");

  last = step({ state, residual, input: {}, deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 1, "step 11: deadlock fires at stepsWithoutEvidence=10");
  assert.equal(last.deadlocks[0].itemKind, "evidence_gap");
  assert.equal(last.deadlocks[0].phi, "sensor_ok");
  assert.equal(last.deadlocks[0].stepsStuck, 10);
});

test("deadlock detection: evidence gap resolved before threshold produces no DeadlockEvent", () => {
  const gap = {
    kind: "evidence_gap" as const,
    phi: "sensor_ok",
    threshold: 0.9,
    escalationSteps: 999,
  };
  let state = createInitialState();
  let residual = createEmptyResidual();

  let last = step({ state, residual, input: {}, proposals: [gap], deadlockThreshold: 10 });
  state = last.stateNext; residual = last.residualNext;

  for (let i = 2; i <= 5; i++) {
    last = step({ state, residual, input: {}, deadlockThreshold: 10 });
    state = last.stateNext; residual = last.residualNext;
  }

  // resolve the gap at step 6
  last = step({ state, residual, input: { evidence: { sensor_ok: 0.95 } }, deadlockThreshold: 10 });
  assert.equal(last.deadlocks.length, 0, "gap resolved — no DeadlockEvent");
  assert.equal(last.residualNext.evidenceGaps.length, 0, "gap discharged from residual");
});

// ── Mission 56: TensionTimeoutPolicy timing boundary ─────────────────────────
// See ARCHITECTURE.md §4.1 for the invariant: policy fires on residualPre
// (carry-overs), not on tensions first introduced in the current step.

test("M56-A: tension introduced at step N with maxSteps=0 is NOT auto-adjudicated until step N+1", () => {
  const state = createInitialState();
  const residual = createEmptyResidual();
  const policy = { maxSteps: 0, resolve: (phi1: string) => phi1 };

  // Step N: tension enters via constraint — it appears in residualNext but was
  // NOT in residualPre (discharge input), so the policy cannot see it yet.
  const sN = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "alpha", phi2: "beta" }] },
    tensionTimeoutPolicy: policy,
    proposals: [],
  });
  assert.equal(sN.autoAdjudications.length, 0, "M56-A: tension introduced this step — policy cannot fire on it yet");
  assert.equal(sN.residualNext.tensions.length, 1, "M56-A: tension is in residualNext");

  // Step N+1: tension is now in residualPre → policy fires and auto-adjudicates.
  const sN1 = step({
    state: sN.stateNext, residual: sN.residualNext,
    input: {},
    tensionTimeoutPolicy: policy,
    proposals: [],
  });
  assert.equal(sN1.autoAdjudications.length, 1, "M56-A: policy fires at step N+1 — tension now in residualPre");
  assert.equal(sN1.autoAdjudications[0].winner, "alpha");
});

test("M56-B: tension already in residualPre at step N CAN be manually adjudicated at step N", () => {
  const state = createInitialState();
  const residual = createEmptyResidual();

  // Step N-1: introduce the tension so it is in residualPre at step N.
  const sPrev = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "alpha", phi2: "beta" }] },
    proposals: [],
  });
  assert.equal(sPrev.residualNext.tensions.length, 1, "M56-B: tension present in residualNext after step N-1");

  // Step N: tension is now in residualPre — manual adjudication can resolve it here.
  const sN = step({
    state: sPrev.stateNext, residual: sPrev.residualNext,
    input: { adjudications: [{ phi1: "alpha", phi2: "beta", winner: "alpha" }] },
    proposals: [],
  });

  assert.equal(sN.residualNext.tensions.length, 0, "M56-B: tension manually adjudicated in the step where it is in residualPre");
  assert.ok(sN.stateNext.rejected.includes("beta"), "M56-B: loser rejected after manual adjudication");
});
