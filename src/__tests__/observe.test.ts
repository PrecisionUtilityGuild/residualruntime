import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { diffStep, computeMetrics, summarizeTrace, buildAssuranceBundle } from "../runtime/observe";

function buildFailureCaseEvents() {
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [actionA] });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionA],
  });
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [actionB] });

  return [s1.replay, s2.replay, s3.replay];
}

test("diffStep: identifies tension removed and action approved between step1 and step2", () => {
  const [e1, e2] = buildFailureCaseEvents();
  const diff = diffStep(e1, e2);

  assert.equal(diff.tensionsRemoved.length, 1, "one tension removed");
  assert.equal(diff.tensionsRemoved[0].phi1, "x=true");
  assert.equal(diff.actionsApproved.length, 1);
  assert.equal(diff.actionsApproved[0].type, "USE_X_TRUE");
});

test("computeMetrics: correct blockedRate over 3-step failure case", () => {
  const events = buildFailureCaseEvents();
  const m = computeMetrics(events);

  assert.equal(m.totalSteps, 3);
  assert.equal(m.totalActionsBlocked, 2);
  assert.equal(m.totalActionsApproved, 1);
  assert.equal(m.totalSessionConflicts, 0);
  assert.equal(m.totalSessionArbitrations, 0);
  assert.ok(Math.abs(m.blockedRate - 2 / 3) < 0.001, `expected ~0.667, got ${m.blockedRate}`);
});

test("computeMetrics: counts cross-session conflict/arbitration replay events", () => {
  const events = buildFailureCaseEvents();
  events[1] = {
    ...events[1],
    sessionEvents: {
      conflicts: [
        {
          kind: "session_conflict",
          action: { kind: "action", type: "WRITE_A", writeSet: ["resource:a"] },
          otherAction: { kind: "action", type: "WRITE_B", writeSet: ["resource:a"] },
          otherSessionId: "peer-1",
          conflictType: "write_write",
          resource: "resource:a",
          scope: { kind: "branch", value: "feature/shared" },
          reason: "write/write overlap",
          unblock: [{ kind: "wait_for_other_session", detail: "wait" }],
        },
      ],
      arbitrations: [
        {
          kind: "session_arbitration",
          action: { kind: "action", type: "WRITE_A", writeSet: ["resource:a"] },
          otherAction: { kind: "action", type: "WRITE_B", writeSet: ["resource:a"] },
          sessionId: "s1",
          otherSessionId: "peer-1",
          conflictType: "write_write",
          resource: "resource:a",
          scope: { kind: "branch", value: "feature/shared" },
          mode: "serialize_first",
          outcome: "serialize_wait",
          preferredSessionId: "peer-1",
          precedence: {
            conflictRank: 2,
            sessionPriority: 100,
            otherSessionPriority: 200,
            tieBreak: "objective_priority",
          },
          reason: "serialized arbitration",
          unblock: [{ kind: "wait_for_other_session", detail: "wait" }],
        },
      ],
    },
  };

  const m = computeMetrics(events);
  assert.equal(m.totalSessionConflicts, 1);
  assert.equal(m.totalSessionArbitrations, 1);
});

test("summarizeTrace: returns non-empty string with key info", () => {
  const events = buildFailureCaseEvents();
  const summary = summarizeTrace(events);

  assert.ok(summary.length > 0, "summary is non-empty");
  assert.ok(summary.includes("Steps: 3"), "includes step count");
  assert.ok(summary.includes("Blocked"), "includes blocked info");
});

test("summarizeTrace: includes CCP₀ verification status", () => {
  const events = buildFailureCaseEvents();
  const summary = summarizeTrace(events);
  assert.ok(summary.includes("CCP₀ verification: PASS"), `expected PASS line, got: ${summary}`);
});

test("buildAssuranceBundle: exports deterministic assurance package shape", () => {
  const events = buildFailureCaseEvents();
  const bundle = buildAssuranceBundle(events);

  assert.equal(bundle.bundleVersion, "assurance.v1");
  assert.equal(bundle.metrics.totalSteps, 3);
  assert.equal(bundle.attestation.totalSteps, 3);
  assert.equal(bundle.attestation.withAttestation, 3);
  assert.ok(bundle.decision.combinedDecisionHash.length > 0);
  assert.equal(bundle.decision.decisionHashes.length, 3);
  assert.equal(bundle.ccp.valid, true);
  assert.ok(bundle.blockers.blockedActions >= 1);
});
