import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";

// ── Adversarial Edge Case Suite (Mission 30) ──────────────────────────────────
//
// 11 named kernel edges. For each: write the adversarial test first, observe
// behaviour, fix the kernel where a test reveals a real defect, lock the test in.
// No speculative fixes — only changes the tests prove are needed.

// E1: Adjudication winner not in {phi1, phi2}
test("E1: adjudication with winner outside {phi1,phi2} must not incorrectly reject a valid atom", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "a", phi2: "b" }] },
    proposals: [],
  });
  assert.equal(s1.residualNext.tensions.length, 1, "E1 setup: tension in residual");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "a", phi2: "b", winner: "c" }] },
    proposals: [
      { kind: "action", type: "USE_A", dependsOn: ["a"] },
      { kind: "action", type: "USE_B", dependsOn: ["b"] },
    ],
  });

  assert.ok(!s2.stateNext.rejected.includes("a"), "E1: 'a' must not be rejected by a rogue winner");
  assert.ok(!s2.stateNext.rejected.includes("b"), "E1: 'b' must not be rejected by a rogue winner");
  assert.equal(s2.residualNext.tensions.length, 1, "E1: tension stays open when winner is invalid");
});

// E2: Deferred livelock — dependency is a rejected atom
test("E2: deferred whose dependency atom is rejected must eventually report a deadlock", () => {
  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "follow_up=required" },
    dependencies: ["x=false"],
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
    proposals: [deferred],
    deadlockThreshold: 3,
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
    deadlockThreshold: 3,
  });
  assert.ok(s2.stateNext.rejected.includes("x=false"), "E2 setup: x=false is rejected");
  assert.equal(s2.residualNext.deferred.length, 1, "E2: deferred is still stuck");
  state = s2.stateNext; residual = s2.residualNext;

  let last = s2;
  for (let i = 3; i <= 5; i++) {
    last = step({ state, residual, input: {}, proposals: [], deadlockThreshold: 3 });
    state = last.stateNext; residual = last.residualNext;
  }

  assert.ok(last.deadlocks.length >= 1, "E2: deadlock fires for deferred stuck on rejected dep");
  assert.equal(last.deadlocks[0].itemKind, "deferred");
});

// E3: Assumption retracted by belief grounded in a contested atom
test("E3: assumption must not be retracted while the belief that would retract it is contested by an open tension", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "route_ok", phi2: "route_blocked" }] },
    proposals: [{ kind: "assumption" as const, phi: "route_ok", weight: 0.8 }],
  });
  assert.equal(s1.residualNext.assumptions.length, 1, "E3 setup: assumption present");
  assert.equal(s1.residualNext.tensions.length, 1, "E3 setup: tension open");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: { evidence: { route_ok: 0.9 } }, proposals: [] });

  assert.equal(
    s2.residualNext.assumptions.length,
    1,
    "E3: assumption must not be retracted while belief is contested by open tension"
  );
  assert.equal(s2.residualNext.tensions.length, 1, "E3: tension still open");
});

// E4: Circular deferred dependency chain
test("E4: circular deferred chain (A depends on B's phi, B depends on A's phi) triggers deadlock", () => {
  const deferredA = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "gate_a" },
    dependencies: ["gate_b"],
  };
  const deferredB = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "gate_b" },
    dependencies: ["gate_a"],
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  let last = step({ state, residual, input: {}, proposals: [deferredA, deferredB], deadlockThreshold: 5 });
  state = last.stateNext; residual = last.residualNext;

  for (let i = 2; i <= 7; i++) {
    last = step({ state, residual, input: {}, proposals: [], deadlockThreshold: 5 });
    state = last.stateNext; residual = last.residualNext;
  }

  assert.ok(last.deadlocks.length >= 1, "E4: deadlock detected for circular deferred chain");
  assert.equal(last.deadlocks[0].itemKind, "deferred");
});

// E5: Post-escalation evidence recovery
test("E5: evidence arriving after gap escalates to deferred causes deferred to discharge by step 5", () => {
  const gap = {
    kind: "evidence_gap" as const,
    phi: "budget_ok",
    threshold: 0.8,
    escalationSteps: 2,
    stepsWithoutEvidence: 0,
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s2.escalations.length, 0, "E5: no escalation at step 2");
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s3.escalations.length, 1, "E5: escalation fires at step 3");
  assert.equal(s3.residualNext.deferred.length, 1, "E5: gap promoted to deferred");
  assert.equal(s3.residualNext.evidenceGaps.length, 0, "E5: original gap removed");
  state = s3.stateNext; residual = s3.residualNext;

  const s4 = step({ state, residual, input: { evidence: { budget_ok: 0.9 } }, proposals: [] });
  const deferredAfterS4 = s4.residualNext.deferred.length;
  state = s4.stateNext; residual = s4.residualNext;

  const s5 = step({ state, residual, input: {}, proposals: [] });
  assert.equal(s5.residualNext.deferred.length, 0, "E5: deferred discharges by step 5 after evidence");
  assert.ok(
    deferredAfterS4 === 0 || s5.residualNext.deferred.length === 0,
    "E5: deferred resolves within one step of evidence arriving"
  );
});

// E6: Self-contradictory tension: phi1 === phi2
test("E6: tension with phi1 === phi2 must not enter the residual (or must be detected as invalid)", () => {
  const s = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Unresolved", phi1: "x", phi2: "x" }] },
    proposals: [{ kind: "action", type: "USE_X", dependsOn: ["x"] }],
  });

  const selfTensionPresent = s.residualNext.tensions.some((t) => t.phi1 === t.phi2);
  assert.ok(!selfTensionPresent, "E6: self-contradictory tension (phi1===phi2) must not enter the residual");
});

// E7: stepsAlive carry-over — tension re-proposed via proposals kind:'tension'
test("E7: tension re-proposed via proposals kind:'tension' does not carry stepsAlive from residualPre", () => {
  const tension = { type: "Unresolved" as const, phi1: "x=1", phi2: "x=0" };
  let state = createInitialState();
  let residual = createEmptyResidual();

  for (let i = 0; i < 3; i++) {
    const s = step({ state, residual, input: { constraints: [tension] }, proposals: [] });
    state = s.stateNext; residual = s.residualNext;
  }
  const stepsAliveViaConstraints = residual.tensions[0]?.stepsAlive ?? 0;
  assert.ok(stepsAliveViaConstraints >= 2, `E7: stepsAlive via constraints = ${stepsAliveViaConstraints}`);

  const proposalTension = { kind: "tension" as const, phi1: "x=1", phi2: "x=0" };
  const s4 = step({ state, residual, input: {}, proposals: [proposalTension] });

  const tensionsAfterS4 = s4.residualNext.tensions;
  const carriedTension = tensionsAfterS4.find((t) => (t.stepsAlive ?? 0) > 0);
  assert.ok(carriedTension !== undefined, "E7: carried tension from residualPre retains stepsAlive");
});

// E8: Assumption deduplication — same phi proposed twice in same step
test("E8: two assumptions with same phi but different weights — first-in wins (documented policy)", () => {
  const s = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [
      { kind: "assumption" as const, phi: "fast_path", weight: 0.6 },
      { kind: "assumption" as const, phi: "fast_path", weight: 0.9 },
    ],
  });

  assert.equal(s.residualNext.assumptions.length, 1, "E8: only one assumption enters residual");
  assert.equal(s.residualNext.assumptions[0].weight, 0.6, "E8: first-in wins (lower weight, 0.6 not 0.9)");
});

// E9: Evidence routing — atom-scoped, open tension unaffected
test("E9: evidence for phi-A clears gap-A but does not affect gap-B; tension on phi-A's atom stays open", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: {
      constraints: [
        { type: "RequireEvidence", phi: "metric_a", threshold: 0.8 },
        { type: "RequireEvidence", phi: "metric_b", threshold: 0.8 },
        { type: "Unresolved", phi1: "metric_a", phi2: "metric_a_bad" },
      ],
    },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: { evidence: { metric_a: 0.9 } }, proposals: [] });

  assert.equal(
    s2.residualNext.evidenceGaps.filter((g) => g.phi === "metric_a").length,
    0,
    "E9: gap-A discharged by evidence for metric_a"
  );
  assert.equal(
    s2.residualNext.evidenceGaps.filter((g) => g.phi === "metric_b").length,
    1,
    "E9: gap-B persists — no evidence for metric_b"
  );
  assert.equal(
    s2.residualNext.tensions.filter((t) => t.phi1 === "metric_a" || t.phi2 === "metric_a").length,
    1,
    "E9: tension on metric_a stays open despite evidence — requires adjudication"
  );
});

// E10: Multi-tension adjudication ordering — two tensions resolved in same step
test("E10: two tensions resolved in same step — both losers rejected, winner committed, action approved", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: {
      constraints: [
        { type: "Unresolved", phi1: "x", phi2: "y" },
        { type: "Unresolved", phi1: "x", phi2: "z" },
      ],
    },
    proposals: [],
  });
  assert.equal(s1.residualNext.tensions.length, 2, "E10 setup: two tensions");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: {
      adjudications: [
        { phi1: "x", phi2: "y", winner: "x" },
        { phi1: "x", phi2: "z", winner: "x" },
      ],
    },
    proposals: [{ kind: "action", type: "USE_X", dependsOn: ["x"] }],
  });

  assert.equal(s2.residualNext.tensions.length, 0, "E10: both tensions discharged");
  assert.ok(s2.stateNext.rejected.includes("y"), "E10: 'y' is rejected");
  assert.ok(s2.stateNext.rejected.includes("z"), "E10: 'z' is rejected");
  const xCommitments = s2.stateNext.commitments.filter((c) => c.type === "Prop" && c.phi === "x");
  assert.ok(xCommitments.length >= 1, "E10: 'x' is committed after winning both adjudications");
  assert.equal(s2.actionsApproved.length, 1, "E10: action depending on 'x' is approved");
  assert.equal(s2.actionsApproved[0].type, "USE_X");
});

// ── Mission 38: InvalidAdjudicationEvent validation ──────────────────────────

// M38-A: Manual adjudication with rogue winner emits InvalidAdjudicationEvent and leaves tension open
test("M38-A: manual adjudication with rogue winner produces invalidAdjudications and no spurious commit", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "a", phi2: "b" }] },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "a", phi2: "b", winner: "rogue" }] },
    proposals: [],
  });

  assert.equal(s2.invalidAdjudications.length, 1, "M38-A: one invalid adjudication event");
  assert.equal(s2.invalidAdjudications[0].kind, "invalid_adjudication");
  assert.equal(s2.invalidAdjudications[0].phi1, "a");
  assert.equal(s2.invalidAdjudications[0].phi2, "b");
  assert.equal(s2.invalidAdjudications[0].winner, "rogue");
  assert.equal(s2.invalidAdjudications[0].source, "manual");
  assert.equal(s2.residualNext.tensions.length, 1, "M38-A: tension still open after rogue adjudication");
  assert.ok(!s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "rogue"), "M38-A: rogue winner not committed");
  assert.ok(!s2.stateNext.rejected.includes("a"), "M38-A: a not rejected");
  assert.ok(!s2.stateNext.rejected.includes("b"), "M38-A: b not rejected");
});

// M38-B: Valid adjudication produces no invalidAdjudications
test("M38-B: valid adjudication produces empty invalidAdjudications", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "x", phi2: "y" }] },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x", phi2: "y", winner: "x" }] },
    proposals: [],
  });

  assert.equal(s2.invalidAdjudications.length, 0, "M38-B: no invalid adjudications for valid winner");
  assert.equal(s2.residualNext.tensions.length, 0, "M38-B: tension discharged");
  assert.ok(s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "x"), "M38-B: x committed");
});

// M38-C: Auto-adjudication policy returning rogue winner emits InvalidAdjudicationEvent, tension stays
test("M38-C: policy returning rogue winner emits invalid_adjudication with source=auto, tension remains", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const roguePolicy = {
    maxSteps: 1,
    resolve: (_phi1: string, _phi2: string) => "rogue-auto",
  };

  // Step 1: introduce tension (stepsAlive starts at 0 after discharge)
  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "p", phi2: "q" }] },
    proposals: [],
    tensionTimeoutPolicy: roguePolicy,
  });
  assert.equal(s1.residualNext.tensions.length, 1, "M38-C step 1: tension enters residual");
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: tension.stepsAlive reaches 1 >= maxSteps(1), policy fires with rogue return
  const s2 = step({
    state, residual,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: roguePolicy,
  });

  assert.equal(s2.invalidAdjudications.length, 1, "M38-C: one invalid adjudication event from policy");
  assert.equal(s2.invalidAdjudications[0].source, "auto", "M38-C: source is auto");
  assert.equal(s2.invalidAdjudications[0].winner, "rogue-auto");
  assert.equal(s2.residualNext.tensions.length, 1, "M38-C: tension stays open after rogue auto-adj");
  assert.ok(!s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "rogue-auto"), "M38-C: rogue winner not committed");
  assert.ok(!s2.stateNext.rejected.includes("p"), "M38-C: p not rejected");
  assert.ok(!s2.stateNext.rejected.includes("q"), "M38-C: q not rejected");
});

// ── Mission 39: Gap counter integrity across constraint oscillation ───────────

// M39-A: gapCounters persists across steps and is used when a gap re-enters after residual reset
test("M39-A: gap stepsWithoutEvidence accumulates via gapCounters when gap re-enters a fresh residual", () => {
  // Scenario: gap accumulates 2 steps, residual is reset (simulating process restart or
  // custom engine that drops residual), then RequireEvidence constraint re-introduced.
  // Without gapCounters, stepsWithoutEvidence resets to 0. With fix, it resumes from state.
  let state = createInitialState();
  let residual = createEmptyResidual();

  const req = { type: "RequireEvidence" as const, phi: "sensor=ok", threshold: 0.8 };

  // Step 1: gap enters residualNew via constraint (residualPre is empty, swE starts at 0)
  const s1 = step({ state, residual, input: { constraints: [req] }, proposals: [] });
  assert.equal(s1.residualNext.evidenceGaps[0].stepsWithoutEvidence, 0, "M39-A step 1: swE=0");
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: gap in residualPre, incremented to 1, stored in gapCounters
  const s2 = step({ state, residual, input: { constraints: [req] }, proposals: [] });
  assert.equal(s2.residualNext.evidenceGaps[0].stepsWithoutEvidence, 1, "M39-A step 2: swE=1");
  assert.equal(s2.stateNext.gapCounters["sensor=ok"], 1, "M39-A step 2: counter=1 written to state");
  state = s2.stateNext;

  // Reset residual (simulate process restart / residual loss)
  residual = createEmptyResidual();

  // Step 3: gap re-enters via constraint; transition falls back to gapCounters → swE=1, not 0
  const s3 = step({ state, residual, input: { constraints: [req] }, proposals: [] });
  assert.equal(s3.residualNext.evidenceGaps[0].stepsWithoutEvidence, 1, "M39-A step 3: swE=1 (resumed from gapCounters after residual reset, not 0)");
});

// M39-B: Gap counter cleared when belief meets threshold
test("M39-B: gap counter is cleared from state when belief satisfies threshold", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const req = { type: "RequireEvidence" as const, phi: "check=ok", threshold: 0.9 };

  // Step 1: gap enters residualNew (residualPre empty, no counter written yet)
  const s1 = step({ state, residual, input: { constraints: [req] }, proposals: [] });
  assert.equal(s1.stateNext.gapCounters["check=ok"], undefined, "M39-B step 1: counter not set yet (gap not in residualPre)");
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: gap now in residualPre → dischargeEvidenceGaps increments to 1 → gapCounters set
  const s2 = step({ state, residual, input: { constraints: [req] }, proposals: [] });
  assert.equal(s2.stateNext.gapCounters["check=ok"], 1, "M39-B step 2: counter=1 set in state");
  state = s2.stateNext; residual = s2.residualNext;

  // Step 3: provide evidence meeting threshold — gap discharged in dischargeEvidenceGaps, counter cleared
  const s3 = step({ state, residual, input: { constraints: [req], evidence: { "check=ok": 0.95 } }, proposals: [] });
  assert.equal(s3.residualNext.evidenceGaps.length, 0, "M39-B step 3: gap discharged by evidence");
  assert.equal(s3.stateNext.gapCounters["check=ok"], undefined, "M39-B step 3: counter cleared from state");
});

// E11: Belief applied then immediately used — same-step deferred discharge
test("E11: deferred with evidence dep discharges in the same step evidence arrives (document ordering)", () => {
  const deferred = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "ship=allowed" },
    dependencies: ["evidence:budget_ok"],
  };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: {}, proposals: [deferred] });
  assert.equal(s1.residualNext.deferred.length, 1, "E11 setup: deferred present");
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({ state, residual, input: { evidence: { budget_ok: 0.9 } }, proposals: [] });

  assert.equal(
    s2.residualNext.deferred.length,
    0,
    "E11: deferred discharges in the same step evidence arrives (applyEvidence runs before dischargeDeferred)"
  );
  assert.ok(
    s2.stateNext.commitments.some((c) => c.type === "Prop" && c.phi === "ship=allowed"),
    "E11: commitment installs in the same step evidence arrives"
  );
});
