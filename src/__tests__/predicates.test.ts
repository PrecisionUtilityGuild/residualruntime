import test from "node:test";
import assert from "node:assert/strict";
import { whatWouldUnblock } from "../runtime/predicates";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import type { Action, ResidualDelta } from "../runtime/model";

const action = (type: string, dependsOn: string[]): Action => ({
  kind: "action",
  type,
  dependsOn,
});

// ── M44-A: already unblocked ─────────────────────────────────────────────────
test("whatWouldUnblock: already-unblocked action returns permanent=false, deltas=[]", () => {
  const result = whatWouldUnblock(
    action("PAY", ["approved_budget"]),
    createEmptyResidual(),
    createInitialState()
  );
  assert.equal(result.permanent, false);
  assert.deepEqual(result.deltas, []);
});

// ── M44-B: permanently blocked (rejected atom) ───────────────────────────────
test("whatWouldUnblock: permanently-blocked action (rejected atom) returns permanent=true, deltas=[]", () => {
  const state = { ...createInitialState(), rejected: ["x=false"] };
  const result = whatWouldUnblock(
    action("USE_X_FALSE", ["x=false"]),
    createEmptyResidual(),
    state
  );
  assert.equal(result.permanent, true);
  assert.deepEqual(result.deltas, []);
});

// ── M44-C: tension-blocked ───────────────────────────────────────────────────
test("whatWouldUnblock: tension-blocked action returns two adjudicate-tension deltas (one per side)", () => {
  const residual = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "ship_fast", phi2: "full_review" }],
  };
  const result = whatWouldUnblock(
    action("DEPLOY", ["ship_fast"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false);
  assert.equal(result.deltas.length, 2);
  const kinds = result.deltas.map((d) => d.kind);
  assert.ok(kinds.every((k) => k === "adjudicate-tension"));

  const winners = result.deltas.map((d) => (d as Extract<ResidualDelta, { kind: "adjudicate-tension" }>).winner);
  assert.ok(winners.includes("ship_fast"));
  assert.ok(winners.includes("full_review"));
});

// ── M44-D: evidence-gap-blocked ──────────────────────────────────────────────
test("whatWouldUnblock: evidence-gap-blocked action returns satisfy-evidence-gap delta with correct threshold", () => {
  const residual = {
    ...createEmptyResidual(),
    evidenceGaps: [{ kind: "evidence_gap" as const, phi: "approved_budget", threshold: 0.8 }],
  };
  const result = whatWouldUnblock(
    action("PAY", ["approved_budget"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false);
  assert.equal(result.deltas.length, 1);
  assert.equal(result.deltas[0].kind, "satisfy-evidence-gap");
  const delta = result.deltas[0] as Extract<ResidualDelta, { kind: "satisfy-evidence-gap" }>;
  assert.equal(delta.phi, "approved_budget");
  assert.equal(delta.requiredBelief, 0.8);
});

// ── M44-E: deferred-dependency-blocked ───────────────────────────────────────
test("whatWouldUnblock: deferred-dependency-blocked action returns commit-deferred-dependency delta", () => {
  const residual = {
    ...createEmptyResidual(),
    deferred: [{
      kind: "deferred" as const,
      constraint: { type: "Prop" as const, phi: "contract_signed" },
      dependencies: ["legal_approval"],
    }],
  };
  const result = whatWouldUnblock(
    action("EXECUTE", ["contract_signed"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false);
  assert.equal(result.deltas.length, 1);
  assert.equal(result.deltas[0].kind, "commit-deferred-dependency");
  const delta = result.deltas[0] as Extract<ResidualDelta, { kind: "commit-deferred-dependency" }>;
  assert.equal(delta.phi, "contract_signed");
});

// ── M44-F: multi-blocker ─────────────────────────────────────────────────────
test("whatWouldUnblock: multi-blocker action returns all required deltas (tension + evidence gap)", () => {
  const residual = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "approve", phi2: "reject" }],
    evidenceGaps: [{ kind: "evidence_gap" as const, phi: "risk_score", threshold: 0.9 }],
  };
  const result = whatWouldUnblock(
    action("COMMIT", ["approve", "risk_score"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false);
  // Two tension deltas (one per winner option) + one evidence gap delta
  assert.equal(result.deltas.length, 3);
  const byKind = (k: string) => result.deltas.filter((d) => d.kind === k);
  assert.equal(byKind("adjudicate-tension").length, 2);
  assert.equal(byKind("satisfy-evidence-gap").length, 1);
});

// ── M44-G: assumption-advisory ───────────────────────────────────────────────
// Assumptions are enabling, not blocking. blocks() does not check residual.assumptions,
// so an action whose only dependency is held by an assumption is NOT hard-blocked.
// whatWouldUnblock returns permanent=false, deltas=[] (already unblocked).
test("whatWouldUnblock: action whose dep is held only by an assumption is not blocked — returns permanent=false, deltas=[]", () => {
  const residual = {
    ...createEmptyResidual(),
    assumptions: [{ kind: "assumption" as const, phi: "budget_ok", weight: 0.7 }],
  };
  const result = whatWouldUnblock(
    action("PAY", ["budget_ok"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false, "assumption does not hard-block — not permanent");
  assert.deepEqual(result.deltas, [], "no deltas — action is not blocked by an assumption");
});

// ── M44-H: no duplicate deltas for same phi ──────────────────────────────────
test("whatWouldUnblock: does not produce duplicate deltas for the same phi", () => {
  const residual = {
    ...createEmptyResidual(),
    evidenceGaps: [
      { kind: "evidence_gap" as const, phi: "score", threshold: 0.8 },
      { kind: "evidence_gap" as const, phi: "score", threshold: 0.9 },
    ],
  };
  const result = whatWouldUnblock(
    action("ACT", ["score"]),
    residual,
    createInitialState()
  );

  assert.equal(result.permanent, false);
  // Two distinct evidence gaps with same phi — deduped to one delta
  assert.equal(result.deltas.filter((d) => d.kind === "satisfy-evidence-gap").length, 1);
});

// ── Mission 53: sufficient flag ───────────────────────────────────────────────

test("whatWouldUnblock: single-blocker delta is sufficient=true", () => {
  // Only one evidence gap blocks the action — satisfying it fully unblocks.
  const residual = {
    ...createEmptyResidual(),
    evidenceGaps: [{ kind: "evidence_gap" as const, phi: "budget_approved", threshold: 0.8 }],
  };
  const result = whatWouldUnblock(action("PAY", ["budget_approved"]), residual, createInitialState());
  assert.equal(result.permanent, false);
  assert.equal(result.deltas.length, 1);
  assert.equal(result.deltas[0].sufficient, true, "sole blocking condition — delta is sufficient");
});

test("whatWouldUnblock: multi-blocker deltas are each sufficient=false", () => {
  // Two independent blockers: a tension AND an evidence gap. Neither alone unblocks.
  const residual = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "approve", phi2: "reject" }],
    evidenceGaps: [{ kind: "evidence_gap" as const, phi: "risk_score", threshold: 0.9 }],
  };
  const result = whatWouldUnblock(
    action("COMMIT", ["approve", "risk_score"]),
    residual,
    createInitialState()
  );
  assert.equal(result.permanent, false);
  // There are 3 deltas: adjudicate-tension×2 + satisfy-evidence-gap×1
  assert.ok(result.deltas.length >= 2, "at least two deltas returned");
  assert.ok(result.deltas.every((d) => d.sufficient === false), "no single delta is sufficient when multiple blockers exist");
});

test("whatWouldUnblock: adjudicate-tension sufficient=true only for the winning side that actually clears the block", () => {
  // Action depends on "ship_fast" only — so adjudicating winner=ship_fast removes the tension and unblocks.
  // Adjudicating winner=full_review removes the tension but "ship_fast" is now rejected → still blocked.
  const residual = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "ship_fast", phi2: "full_review" }],
  };
  const result = whatWouldUnblock(action("DEPLOY", ["ship_fast"]), residual, createInitialState());
  assert.equal(result.permanent, false);
  assert.equal(result.deltas.length, 2);
  const winShipFast = result.deltas.find((d) => d.kind === "adjudicate-tension" && (d as Extract<ResidualDelta, { kind: "adjudicate-tension" }>).winner === "ship_fast")!;
  const winFullReview = result.deltas.find((d) => d.kind === "adjudicate-tension" && (d as Extract<ResidualDelta, { kind: "adjudicate-tension" }>).winner === "full_review")!;
  assert.equal(winShipFast.sufficient, true, "winning the needed atom unblocks the action");
  assert.equal(winFullReview.sufficient, false, "winning the other side rejects the needed atom — still blocked");
});

// ── Mission 54: permanent flag distinguishes permanently-blocked from already-unblocked ──
test("whatWouldUnblock: permanent=true is distinct from already-unblocked (permanent=false)", () => {
  const state = { ...createInitialState(), rejected: ["bad_atom"] };
  const permanentResult = whatWouldUnblock(action("ACT", ["bad_atom"]), createEmptyResidual(), state);
  const freeResult = whatWouldUnblock(action("ACT", ["bad_atom"]), createEmptyResidual(), createInitialState());

  assert.equal(permanentResult.permanent, true, "rejected atom → permanently blocked");
  assert.deepEqual(permanentResult.deltas, []);
  assert.equal(freeResult.permanent, false, "no blocker → not permanent");
  assert.deepEqual(freeResult.deltas, []);
});
