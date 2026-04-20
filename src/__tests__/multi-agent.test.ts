import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";

// ── Multi-Agent Residual Sharing: ICU Triage ──────────────────────────────────
//
// Three agents (diagnostics, pharmacy, surgeon) share a single (state, residual).
// Assertions verify the three core claims of the multi-agent architecture:
//
//   (1) While a tension is open, ALL agents depending on either side are blocked.
//   (2) After adjudication by one agent, ALL other agents see the same unblocked state.
//   (3) The losing branch is permanently foreclosed — even a "fresh" agent proposal
//       depending on the loser is rejected.

test("multi-agent: surgery blocked on heparin tension while pharmacy holds dispute open", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const diagnosticsStep = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "heparin_safe", phi2: "heparin_contraindicated" }] },
    proposals: [],
  });
  state = diagnosticsStep.stateNext;
  residual = diagnosticsStep.residualNext;

  const surgeryStep = step({
    state, residual,
    input: {},
    proposals: [{ kind: "action", type: "ADMINISTER_HEPARIN", dependsOn: ["heparin_safe"] }],
  });

  assert.equal(surgeryStep.actionsApproved.length, 0, "surgery: ADMINISTER_HEPARIN blocked while dispute open");
  assert.equal(surgeryStep.actionsBlocked.length, 1);
  assert.equal(surgeryStep.actionsBlocked[0].type, "ADMINISTER_HEPARIN");
  assert.ok(residual.tensions.some((t) => t.phi1 === "heparin_safe"), "shared residual carries the open tension");
});

test("multi-agent: after surgeon adjudicates, pharmacy sees unblocked state on same residual", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "blood_type=O-", phi2: "blood_type=A+" }] },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const pharmacyBlocked = step({
    state, residual,
    input: {},
    proposals: [{ kind: "action", type: "CROSSMATCH_BLOOD_O-", dependsOn: ["blood_type=O-"] }],
  });
  assert.equal(pharmacyBlocked.actionsApproved.length, 0, "pharmacy blocked before adjudication");

  const adjStep = step({
    state, residual,
    input: { adjudications: [{ phi1: "blood_type=O-", phi2: "blood_type=A+", winner: "blood_type=O-" }] },
    proposals: [],
  });
  state = adjStep.stateNext; residual = adjStep.residualNext;

  const pharmacyUnblocked = step({
    state, residual,
    input: {},
    proposals: [{ kind: "action", type: "CROSSMATCH_BLOOD_O-", dependsOn: ["blood_type=O-"] }],
  });
  assert.equal(pharmacyUnblocked.actionsApproved.length, 1, "pharmacy approved after adjudication");
  assert.equal(pharmacyUnblocked.actionsApproved[0].type, "CROSSMATCH_BLOOD_O-");
  assert.equal(residual.tensions.length, 0, "shared residual: tension cleared");
});

test("multi-agent: losing branch permanently forecloses across all agents", () => {
  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({
    state, residual,
    input: { constraints: [{ type: "Unresolved", phi1: "blood_type=O-", phi2: "blood_type=A+" }] },
    proposals: [],
  });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "blood_type=O-", phi2: "blood_type=A+", winner: "blood_type=O-" }] },
    proposals: [],
  });
  state = s2.stateNext; residual = s2.residualNext;

  assert.ok(state.rejected.includes("blood_type=A+"), "A+ in rejected after adjudication");

  const freshAgentStep = step({
    state, residual,
    input: {},
    proposals: [
      { kind: "action", type: "CROSSMATCH_BLOOD_A+", dependsOn: ["blood_type=A+"] },
      { kind: "action", type: "CROSSMATCH_BLOOD_O-", dependsOn: ["blood_type=O-"] },
    ],
  });

  assert.equal(freshAgentStep.actionsBlocked.length, 1, "A+ cross-match permanently blocked");
  assert.equal(freshAgentStep.actionsBlocked[0].type, "CROSSMATCH_BLOOD_A+");
  assert.equal(freshAgentStep.actionsApproved.length, 1, "O- cross-match approved");
  assert.equal(freshAgentStep.actionsApproved[0].type, "CROSSMATCH_BLOOD_O-");
});
