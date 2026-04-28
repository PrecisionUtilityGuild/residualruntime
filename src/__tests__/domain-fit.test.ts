import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { whatWouldUnblock } from "../runtime/predicates";
import { createEmptyResidual, createInitialState } from "../runtime/model";

test("domain-fit finance: settlement blocks on dispute and approves after adjudication", () => {
  const settle = {
    kind: "action" as const,
    type: "SETTLE_TRADE",
    dependsOn: ["counterparty=solvent"],
  };

  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [
        {
          type: "Unresolved",
          phi1: "counterparty=solvent",
          phi2: "counterparty=default_risk",
        },
      ],
    },
    proposals: [settle],
  });

  assert.equal(s1.actionsApproved.length, 0);
  assert.equal(s1.actionsBlocked.length, 1, "finance settlement should block while solvency is disputed");
  const unblock = whatWouldUnblock(settle, s1.residualNext, s1.stateNext);
  assert.equal(unblock.permanent, false);
  assert.ok(
    unblock.deltas.some((delta) => delta.kind === "adjudicate-tension"),
    "unblock analysis should propose adjudicating the solvency tension"
  );

  const s2 = step({
    state: s1.stateNext,
    residual: s1.residualNext,
    input: {
      adjudications: [
        {
          phi1: "counterparty=solvent",
          phi2: "counterparty=default_risk",
          winner: "counterparty=solvent",
        },
      ],
    },
    proposals: [settle],
  });
  assert.equal(s2.actionsApproved.length, 1, "finance settlement should approve once dispute is resolved");
  assert.equal(s2.actionsBlocked.length, 0);
});

test("domain-fit medical: blockers narrow from evidence+signoff to signoff-only before approval", () => {
  const administer = {
    kind: "action" as const,
    type: "ADMINISTER_HEPARIN",
    dependsOn: ["coag_panel_ok", "attending_signoff"],
  };
  const deferredSignoff = {
    kind: "deferred" as const,
    constraint: { type: "Prop" as const, phi: "attending_signoff" },
    dependencies: ["attending_note_complete"],
  };

  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "RequireEvidence", phi: "coag_panel_ok", threshold: 0.9 }],
    },
    proposals: [deferredSignoff, administer],
  });
  assert.equal(s1.actionsApproved.length, 0);
  assert.equal(s1.actionsBlocked.length, 1, "medical action should block on both missing evidence and signoff");

  const unblock1 = whatWouldUnblock(administer, s1.residualNext, s1.stateNext);
  assert.ok(unblock1.deltas.some((delta) => delta.kind === "satisfy-evidence-gap"));
  assert.ok(unblock1.deltas.some((delta) => delta.kind === "commit-deferred-dependency"));

  const s2 = step({
    state: s1.stateNext,
    residual: s1.residualNext,
    input: { evidence: { coag_panel_ok: 0.95 } },
    proposals: [administer],
  });
  assert.equal(s2.actionsApproved.length, 0);
  assert.equal(s2.actionsBlocked.length, 1, "after evidence, action should still block on deferred signoff");

  const unblock2 = whatWouldUnblock(administer, s2.residualNext, s2.stateNext);
  assert.ok(unblock2.deltas.some((delta) => delta.kind === "commit-deferred-dependency"));
  assert.ok(
    !unblock2.deltas.some((delta) => delta.kind === "satisfy-evidence-gap"),
    "once evidence is satisfied, unblock guidance should narrow to signoff dependency"
  );

  const s3 = step({
    state: s2.stateNext,
    residual: s2.residualNext,
    input: { constraints: [{ type: "Prop", phi: "attending_note_complete" }] },
    proposals: [administer],
  });
  assert.equal(s3.actionsApproved.length, 0);
  assert.equal(s3.actionsBlocked.length, 1, "dependency commitment step still carries deferred signoff");

  const s4 = step({
    state: s3.stateNext,
    residual: s3.residualNext,
    input: {},
    proposals: [administer],
  });
  assert.equal(s4.actionsApproved.length, 1, "medical action should approve after deferred signoff materializes");
  assert.equal(s4.actionsBlocked.length, 0);
});

test("domain-fit security/ops: reopened operational dispute revokes previously approved revocable action", () => {
  const deploy = {
    kind: "action" as const,
    type: "DEPLOY_PATCH",
    dependsOn: ["vuln_scan_cleared"],
    revocable: true,
  };

  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Prop", phi: "vuln_scan_cleared" }] },
    proposals: [deploy],
  });

  assert.equal(s1.actionsApproved.length, 1);
  assert.equal(s1.emittedRevocable.length, 1, "deploy action should be tracked as revocable");

  const s2 = step({
    state: s1.stateNext,
    residual: s1.residualNext,
    input: {
      constraints: [
        {
          type: "Unresolved",
          phi1: "vuln_scan_cleared",
          phi2: "vuln_scan_regressed",
        },
      ],
    },
    proposals: [],
    priorRevocable: s1.emittedRevocable,
  });

  assert.equal(
    s2.revokedActions.length,
    1,
    "revocable deploy should be revoked once a fresh unresolved scan dispute appears"
  );
  assert.equal(s2.revokedActions[0].type, "DEPLOY_PATCH");
});

test("domain-fit manufacturing safety: adjudicated losing branch remains permanently foreclosed", () => {
  const startLine = {
    kind: "action" as const,
    type: "START_ASSEMBLY_LINE",
    dependsOn: ["line=status_run"],
  };

  const s1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [
        {
          type: "Unresolved",
          phi1: "line=status_run",
          phi2: "line=status_stop",
        },
      ],
    },
    proposals: [],
  });

  const s2 = step({
    state: s1.stateNext,
    residual: s1.residualNext,
    input: {
      adjudications: [
        {
          phi1: "line=status_run",
          phi2: "line=status_stop",
          winner: "line=status_stop",
        },
      ],
    },
    proposals: [],
  });

  const s3 = step({
    state: s2.stateNext,
    residual: s2.residualNext,
    input: {},
    proposals: [startLine],
  });

  assert.equal(s3.actionsApproved.length, 0);
  assert.equal(s3.actionsBlocked.length, 1);

  const unblock = whatWouldUnblock(startLine, s3.residualNext, s3.stateNext);
  assert.equal(unblock.permanent, true, "manufacturing start action should be permanently foreclosed on rejected atom");
  assert.deepEqual(unblock.deltas, []);
});

test("domain-fit risk tier: blocked high-risk action emits deterministic risk escalation", () => {
  const highRiskDeploy = {
    kind: "action" as const,
    type: "DEPLOY_TO_PRODUCTION",
    riskTier: "high" as const,
    dependsOn: ["security_scan_ok"],
  };

  const blocked = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {
      constraints: [{ type: "RequireEvidence", phi: "security_scan_ok", threshold: 0.95 }],
      evidence: { security_scan_ok: 0.6 },
    },
    proposals: [highRiskDeploy],
  });

  assert.equal(blocked.actionsApproved.length, 0);
  assert.equal(blocked.actionsBlocked.length, 1);
  assert.equal(blocked.riskEscalations.length, 1);
  assert.equal(blocked.riskEscalations[0].tier, "high");
  assert.equal(blocked.riskEscalations[0].requiredHumanReview, true);
  assert.equal(blocked.riskEscalations[0].reason, "blocked_high_risk_action");
});
