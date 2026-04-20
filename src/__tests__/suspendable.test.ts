import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { mergeConstraints } from "../runtime/constraints";

// ── Suspendable: soft-blocks, not hard-blocks ─────────────────────────────────

test("Suspendable: action in dependsOn is soft-blocked (approved, not hard-blocked)", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "Suspendable", phi: "feature_flag", condition: "flag_enabled" }],
    },
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["feature_flag"] }],
  });

  assert.equal(result.actionsApproved.length, 1, "action is approved (not hard-blocked)");
  assert.equal(result.actionsBlocked.length, 0, "action is not hard-blocked");
  assert.equal(result.softBlocked.length, 1, "action appears in softBlocked");
  assert.equal(result.softBlocked[0].action.type, "DEPLOY");
  assert.equal(result.softBlocked[0].unmetPreferences[0].phi, "feature_flag");
});

test("Suspendable: action whose dependsOn does not include suspended phi is not soft-blocked", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "Suspendable", phi: "other_flag", condition: "flag_enabled" }],
    },
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["feature_flag"] }],
  });

  assert.equal(result.actionsApproved.length, 1);
  assert.equal(result.softBlocked.length, 0, "unrelated phi does not soft-block");
});

test("Suspendable: cleared when constraint removed from next step", () => {
  const step1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "Suspendable", phi: "feature_flag", condition: "flag_enabled" }],
    },
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["feature_flag"] }],
  });

  assert.equal(step1.softBlocked.length, 1, "soft-blocked in step 1");

  // Step 2: no Suspendable constraint — cleared
  const step2 = step({
    state: step1.stateNext,
    residual: step1.residualNext,
    input: {},
    proposals: [{ kind: "action", type: "DEPLOY", dependsOn: ["feature_flag"] }],
  });

  assert.equal(step2.actionsApproved.length, 1, "approved in step 2");
  assert.equal(step2.softBlocked.length, 0, "no longer soft-blocked");
});

test("mergeConstraints: deduplicates identical Suspendable constraints", () => {
  const s = { type: "Suspendable" as const, phi: "flag", condition: "cond" };
  const merged = mergeConstraints([s], [s]);
  assert.equal(merged.filter((c) => c.type === "Suspendable").length, 1);
});

test("mergeConstraints: keeps distinct Suspendable constraints (different condition)", () => {
  const a = { type: "Suspendable" as const, phi: "flag", condition: "cond_a" };
  const b = { type: "Suspendable" as const, phi: "flag", condition: "cond_b" };
  const merged = mergeConstraints([a], [b]);
  assert.equal(merged.filter((c) => c.type === "Suspendable").length, 2);
});

// ── Revocable actions ─────────────────────────────────────────────────────────

test("revocable: approved revocable action appears in emittedRevocable", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { evidence: { budget: 0.95 } },
    proposals: [{ kind: "action", type: "PAY", dependsOn: ["budget"], revocable: true }],
  });

  assert.equal(result.actionsApproved.length, 1);
  assert.equal(result.emittedRevocable.length, 1);
  assert.equal(result.emittedRevocable[0].type, "PAY");
  assert.equal(result.revokedActions.length, 0);
});

test("revocable: non-revocable approved action does not appear in emittedRevocable", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [{ kind: "action", type: "LOG", dependsOn: [] }],
  });

  assert.equal(result.actionsApproved.length, 1);
  assert.equal(result.emittedRevocable.length, 0);
});

test("revocable: previously emitted revocable action appears in revokedActions when now blocked", () => {
  // Step 1: approve a revocable action — no blocking residual yet
  const step1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [{ kind: "action", type: "PAY", dependsOn: ["budget_approved"], revocable: true }],
  });

  assert.equal(step1.emittedRevocable.length, 1);

  // Step 2: open a tension on budget_approved — PAY now blocked by that atom
  const step2 = step({
    state: step1.stateNext,
    residual: step1.residualNext,
    input: {
      constraints: [{ type: "Unresolved", phi1: "budget_approved", phi2: "budget_rejected" }],
    },
    proposals: [],
    priorRevocable: step1.emittedRevocable,
  });

  assert.equal(step2.revokedActions.length, 1, "PAY should be revoked");
  assert.equal(step2.revokedActions[0].type, "PAY");
});

test("revocable: previously emitted revocable action not revoked when still unblocked", () => {
  const step1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { evidence: { budget: 0.95 } },
    proposals: [{ kind: "action", type: "PAY", dependsOn: ["budget"], revocable: true }],
  });

  // Step 2: still sufficient — no revocation
  const step2 = step({
    state: step1.stateNext,
    residual: step1.residualNext,
    input: { evidence: { budget: 0.99 } },
    proposals: [],
    priorRevocable: step1.emittedRevocable,
  });

  assert.equal(step2.revokedActions.length, 0);
});
