import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";

test("deferred Prop dependency waits until the dependency is committed", () => {
  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "ship=allowed" },
    dependencies: ["approval=granted"],
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [deferred] });
  assert.equal(s1.residualNext.deferred.length, 1, "step 1: deferred item is carried");
  assert.ok(!s1.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "ship=allowed"));
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { constraints: [{ type: "Prop", phi: "approval=granted" }] },
    proposals: [],
  });
  assert.equal(s2.residualNext.deferred.length, 1, "step 2: deferred waits through the step where approval is committed");
  assert.ok(s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "approval=granted"));
  assert.ok(!s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "ship=allowed"));
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s3.residualNext.deferred.length, 0, "step 3: deferred discharges after dependency is settled");
  assert.ok(s3.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "ship=allowed"));
});

test("deferred Prop dependency stays pending while the dependency is under open tension", () => {
  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "launch=allowed" },
    dependencies: ["approval=granted"],
  };
  const tension = { type: "Unresolved" as const, phi1: "approval=granted", phi2: "approval=denied" };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [deferred] });
  assert.equal(s1.residualNext.tensions.length, 1, "step 1: tension enters residual");
  assert.equal(s1.residualNext.deferred.length, 1, "step 1: deferred enters residual");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s2.residualNext.deferred.length, 1, "step 2: deferred stays pending while tension is open");
  assert.equal(s2.residualNext.tensions.length, 1, "step 2: tension is still live");
  assert.ok(!s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "launch=allowed"));
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({
    state, residual,
    input: { adjudications: [{ phi1: "approval=granted", phi2: "approval=denied", winner: "approval=granted" }] },
    proposals: [],
  });
  assert.equal(s3.residualNext.deferred.length, 0, "step 3: deferred discharges once the dependency wins adjudication");
  assert.ok(s3.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "launch=allowed"));
});

test("assumption decay: retracted after enough steps without contradicting evidence", () => {
  const assumption = { kind: "assumption" as const, phi: "fast_path", weight: 1.0, decayPerStep: 0.4 };
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [assumption] });
  assert.equal(s1.residualNext.assumptions.length, 1, "step 1: assumption present");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s2.residualNext.assumptions.length, 1, "step 2: still present (weight 0.6)");
  assert.ok(Math.abs(s2.residualNext.assumptions[0].weight - 0.6) < 0.001, "step 2: weight=0.6");
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s3.residualNext.assumptions.length, 1, "step 3: still present (weight 0.2)");
  state = s3.stateNext; residual = s3.residualNext;

  const s4 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s4.residualNext.assumptions.length, 0, "step 4: assumption retracted after decay");
});

test("assumption decay: assumption without decayPerStep is unaffected", () => {
  const assumption = { kind: "assumption" as const, phi: "stable_path", weight: 1.0 };
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [assumption] });
  state = s1.stateNext; residual = s1.residualNext;

  for (let i = 0; i < 5; i++) {
    const si = step({ state, residual, input: {}, proposals: [] });
    assert.equal(si.residualNext.assumptions.length, 1, `step ${i + 2}: non-decaying assumption persists`);
    state = si.stateNext; residual = si.residualNext;
  }
});

test("AGM contraction: belief on loser is cleared after adjudication", () => {
  let state = createInitialState();
  state.belief["x=false"] = 0.9;
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
    proposals: [],
  });

  assert.ok(
    s2.stateNext.belief["x=false"] === undefined || s2.stateNext.belief["x=false"] === 0,
    "loser belief is contracted after adjudication"
  );
  assert.ok(s2.stateNext.rejected.includes("x=false"), "loser is in rejected");
});

test("AGM contraction: winning atom action is not blocked by stale loser belief", () => {
  let state = createInitialState();
  state.belief["x=false"] = 0.9;
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
  });

  assert.equal(s2.actionsApproved.length, 1, "action on winner approved after adjudication");
  assert.equal(s2.actionsBlocked.length, 0);
  assert.ok(
    s2.stateNext.belief["x=false"] === undefined || s2.stateNext.belief["x=false"] === 0,
    "loser belief contracted"
  );
});

test("evidence gap escalation: promoted deferred respects original threshold, not zero", () => {
  // A gap with threshold=0.8 escalates after 1 step (escalationSteps=1 means escalate when
  // stepsWithoutEvidence reaches 1, which happens on step 2 since the gap enters residual on step 1
  // with stepsWithoutEvidence=0 and is incremented to 1 on step 2).
  // The deferred item must remain blocked until belief reaches 0.8, not discharge at any belief > 0.
  let state = createInitialState();
  let residual = createEmptyResidual();

  const gap = { kind: "evidence_gap" as const, phi: "sensor=ready", threshold: 0.8, escalationSteps: 1 };

  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  // Step 1: gap enters residualNew with stepsWithoutEvidence=0
  assert.equal(s1.residualNext.evidenceGaps.length, 1, "step 1: gap enters residual");
  assert.equal(s1.residualNext.deferred.length, 0, "step 1: not yet escalated");
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: gap counter incremented to 1 >= escalationSteps(1) — escalates to deferred
  const s2 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s2.residualNext.evidenceGaps.length, 0, "step 2: gap escalated to deferred");
  assert.equal(s2.residualNext.deferred.length, 1, "step 2: deferred item created");
  state = s2.stateNext; residual = s2.residualNext;

  // Step 3: provide belief=0.3, which is > 0 but < threshold(0.8) — should NOT discharge
  const s3 = step({ state, residual, input: { evidence: { "sensor=ready": 0.3 } }, proposals: [] });
  assert.equal(s3.residualNext.deferred.length, 1, "step 3: deferred stays blocked at belief=0.3 < threshold=0.8");
  assert.ok(
    !s3.stateNext.commitments.some((c) => c.type === "RequireEvidence" && c.phi === "sensor=ready"),
    "step 3: RequireEvidence not yet committed"
  );
  state = s3.stateNext; residual = s3.residualNext;

  // Step 4: provide belief=0.9, which meets the original threshold=0.8 — should discharge
  const s4 = step({ state, residual, input: { evidence: { "sensor=ready": 0.9 } }, proposals: [] });
  assert.equal(s4.residualNext.deferred.length, 0, "step 4: deferred discharges at belief=0.9 >= threshold=0.8");
  assert.ok(
    s4.stateNext.commitments.some((c) => c.type === "RequireEvidence" && c.phi === "sensor=ready"),
    "step 4: RequireEvidence committed after threshold met"
  );
});

// M57: gap re-introduced after full discharge starts stepsWithoutEvidence at 0.
// Verifies that gapCounters is cleared when evidence meets threshold, so a second
// appearance of the same gap does not inherit the old accumulated count.
test("M57: gap re-introduced after full discharge starts stepsWithoutEvidence at 0, not prior count", () => {
  const gap = { kind: "evidence_gap" as const, phi: "sensor_ok", threshold: 0.9, escalationSteps: 5 };
  let state = createInitialState();
  let residual = createEmptyResidual();

  // Phase 1: gap enters and accumulates 3 steps without evidence.
  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  state = s1.stateNext; residual = s1.residualNext;
  const s2 = step({ state, residual, input: {} });
  state = s2.stateNext; residual = s2.residualNext;
  const s3 = step({ state, residual, input: {} });
  state = s3.stateNext; residual = s3.residualNext;
  // Gap enters at s1 with stepsWithoutEvidence=0, increments on s2 and s3 → counter=2.
  assert.equal(state.gapCounters["sensor_ok"], 2, "M57 phase 1: counter at 2 after gap intro + 2 carry-over steps without evidence");

  // Phase 2: evidence satisfies the gap — it discharges and the counter is cleared.
  const sDone = step({ state, residual, input: { evidence: { sensor_ok: 0.95 } } });
  state = sDone.stateNext; residual = sDone.residualNext;
  assert.equal(residual.evidenceGaps.length, 0, "M57: gap fully discharged");
  assert.equal(state.gapCounters["sensor_ok"], undefined, "M57: gapCounters cleared after full discharge");

  // Phase 3: gap re-introduced. Its stepsWithoutEvidence must start at 0, not 3.
  const sReintro = step({ state, residual, input: {}, proposals: [gap] });
  state = sReintro.stateNext; residual = sReintro.residualNext;
  assert.equal(residual.evidenceGaps.length, 1, "M57: gap re-entered residual");
  assert.equal(
    residual.evidenceGaps[0].stepsWithoutEvidence ?? 0,
    0,
    "M57: stepsWithoutEvidence starts at 0 on re-introduction, not at prior accumulated count"
  );
  assert.equal(state.gapCounters["sensor_ok"] ?? 0, 0, "M57: gapCounters starts fresh after re-introduction");
});
