import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step } from "../runtime/engine";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { appendStep, replayLog, ReplayMismatchError, CcpVerificationError, createInMemoryLog } from "../runtime/store";
import { createFileLog } from "../runtime/fileAdapter";

function makeTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "residual-runtime-"));
  return join(dir, "steps.ndjson");
}

test("FileStepLog: appended events survive adapter recreation (process-restart simulation)", () => {
  const path = makeTmpPath();

  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();

  const proposals1 = [{ kind: "action" as const, type: "PAY", dependsOn: ["approved"] }];
  const proposals2 = [{ kind: "action" as const, type: "SHIP", dependsOn: ["approved"] }];

  const input1 = {
    constraints: [{ type: "RequireEvidence" as const, phi: "approved", threshold: 0.9 }],
    evidence: { approved: 0.5 },
  };
  const input2 = { evidence: { approved: 0.95 } };

  // Write phase
  const log1 = createFileLog(path);
  const r1 = step({ state: initialState, residual: initialResidual, input: input1, proposals: proposals1 });
  appendStep(log1, r1.replay);

  const r2 = step({ state: r1.stateNext, residual: r1.residualNext, input: input2, proposals: proposals2 });
  appendStep(log1, r2.replay);

  // Read phase — fresh adapter (simulates process restart)
  const log2 = createFileLog(path);
  const replayed = replayLog(log2, initialState, initialResidual, [proposals1, proposals2]);

  assert.equal(replayed.length, 2);
  assert.deepEqual(
    replayed[0].actionsApproved.map((a) => a.type),
    r1.actionsApproved.map((a) => a.type)
  );
  assert.deepEqual(
    replayed[1].actionsApproved.map((a) => a.type),
    r2.actionsApproved.map((a) => a.type)
  );

  rmSync(path, { force: true });
});

test("FileStepLog: replay throws ReplayMismatchError on divergence", () => {
  const path = makeTmpPath();

  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const proposals = [{ kind: "action" as const, type: "PAY", dependsOn: ["approved"] }];
  const input = { evidence: { approved: 0.99 } };

  const log = createFileLog(path);
  const r = step({ state: initialState, residual: initialResidual, input, proposals });

  // Tamper: swap approved/blocked so replay sees a mismatch
  const tampered = {
    ...r.replay,
    approvedActions: r.replay.blockedActions,
    blockedActions: r.replay.approvedActions,
  };
  appendStep(log, tampered);

  const log2 = createFileLog(path);
  assert.throws(
    () => replayLog(log2, initialState, initialResidual, [proposals]),
    (err: unknown) => err instanceof ReplayMismatchError
  );

  rmSync(path, { force: true });
});

test("FileStepLog: empty file returns no events", () => {
  const path = makeTmpPath();
  const log = createFileLog(path);
  assert.deepEqual(log.readAll(), []);
  rmSync(path, { force: true });
});

// ── CCP₀ verification integration ────────────────────────────────────────────

test("replayLog: ccpVerify:true passes on a valid canonical trace", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();

  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  const log = createInMemoryLog();

  let state = initialState;
  let residual = initialResidual;

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

  // Should not throw
  const results = replayLog(log, initialState, initialResidual, [
    [actionA], [actionA], [actionB],
  ], { ccpVerify: true });

  assert.equal(results.length, 3);
});

// ── Mission 41: Full action identity + state consistency ──────────────────────

test("replayLog: two actions with same type but different dependsOn are treated as distinct", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  // Log an approved action with dependsOn: ["a"]
  const actionA = { kind: "action" as const, type: "DO_THING", dependsOn: ["a"] };
  const r = step({ state: initialState, residual: initialResidual, input: {}, proposals: [actionA] });
  appendStep(log, r.replay);

  // Replay with dependsOn: ["b"] — same type, different identity
  const actionB = { kind: "action" as const, type: "DO_THING", dependsOn: ["b"] };
  assert.throws(
    () => replayLog(log, initialState, initialResidual, [[actionB]]),
    (err: unknown) => err instanceof ReplayMismatchError,
    "replayLog must throw when dependsOn differs even if action.type matches"
  );
});

test("replayLog: stateVerify:true passes when state is consistent", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  const action = { kind: "action" as const, type: "PAY", dependsOn: ["approved"] };
  const input = { evidence: { approved: 0.99 } };

  const r = step({ state: initialState, residual: initialResidual, input, proposals: [action] });
  appendStep(log, r.replay);

  // Should not throw — state matches
  const results = replayLog(log, initialState, initialResidual, [[action]], { stateVerify: true });
  assert.equal(results.length, 1);
});

test("replayLog: stateVerify:true throws on belief divergence from tampered log", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  const action = { kind: "action" as const, type: "PAY", dependsOn: ["approved"] };
  const input = { evidence: { approved: 0.95 } };

  const r = step({ state: initialState, residual: initialResidual, input, proposals: [action] });

  // Tamper: report a different belief in the stored snapshot
  const tampered = {
    ...r.replay,
    after: {
      ...r.replay.after,
      state: {
        ...r.replay.after.state,
        belief: { approved: 0.5 },  // wrong — real replay produces 0.95
      },
    },
  };
  appendStep(log, tampered);

  assert.throws(
    () => replayLog(log, initialState, initialResidual, [[action]], { stateVerify: true }),
    (err: unknown) => err instanceof ReplayMismatchError,
    "stateVerify must throw when belief diverges"
  );
});

test("replayLog: stateVerify:true throws on rejected divergence from tampered log", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };
  let state = initialState;
  let residual = initialResidual;

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [] });
  appendStep(log, s1.replay);
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state, residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [],
  });

  // Tamper: omit "x=false" from rejected
  const tampered = {
    ...s2.replay,
    after: {
      ...s2.replay.after,
      state: { ...s2.replay.after.state, rejected: [] },
    },
  };
  appendStep(log, tampered);

  assert.throws(
    () => replayLog(log, initialState, initialResidual, [[], []], { stateVerify: true }),
    (err: unknown) => err instanceof ReplayMismatchError,
    "stateVerify must throw when rejected set diverges"
  );
});

test("replayLog: stateVerify:true throws on gapCounters divergence from tampered log", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  const gap = {
    kind: "evidence_gap" as const,
    phi: "sensor_ok",
    threshold: 0.9,
    escalationSteps: 999,
  };

  // Step 1: gap enters residual (gapCounters still empty after this step)
  let state = initialState;
  let residual = initialResidual;
  const s1 = step({ state, residual, input: {}, proposals: [gap] });
  appendStep(log, s1.replay);
  state = s1.stateNext; residual = s1.residualNext;

  // Step 2: gap is in residualPre, dischargeEvidenceGaps runs → gapCounters.sensor_ok = 1
  const s2 = step({ state, residual, input: {} });

  // Tamper: report gapCounters:{} instead of {sensor_ok: 1}
  const tampered = {
    ...s2.replay,
    after: {
      ...s2.replay.after,
      state: { ...s2.replay.after.state, gapCounters: {} },
    },
  };
  appendStep(log, tampered);

  assert.throws(
    () => replayLog(log, initialState, initialResidual, [[gap], []], { stateVerify: true }),
    (err: unknown) => err instanceof ReplayMismatchError,
    "stateVerify must throw when gapCounters diverges"
  );
});

test("replayLog: stateVerify:true throws on beliefSupport divergence from tampered log", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();

  const action = { kind: "action" as const, type: "PAY", dependsOn: ["approved"] };
  const input = { evidence: { approved: 0.95 }, constraints: [{ type: "Prop" as const, phi: "approved" }] };

  const r = step({ state: initialState, residual: initialResidual, input, proposals: [action] });

  // Tamper: report empty beliefSupport — real replay will have populated it from evidence + commitments
  const tampered = {
    ...r.replay,
    after: {
      ...r.replay.after,
      state: { ...r.replay.after.state, beliefSupport: { approved: ["EXTRA_PHANTOM"] } },
    },
  };
  appendStep(log, tampered);

  assert.throws(
    () => replayLog(log, initialState, initialResidual, [[action]], { stateVerify: true }),
    (err: unknown) => err instanceof ReplayMismatchError,
    "stateVerify must throw when beliefSupport diverges"
  );
});

test("CcpVerificationError: thrown by verifyCcpTrace on ask-failed-after-tell violation", () => {
  // Construct a synthetic broken CCP trace directly: tell(phi) then ask(phi, failed).
  // This violates ask consistency (phi is in store, so ask-failed is impossible).
  const { verifyCcpTrace } = require("../runtime/verify/ccp0");
  const brokenTrace = {
    ops: [
      { kind: "tell", phi: "budget", stepIndex: 0 },
      { kind: "ask", phi: "budget", stepIndex: 1, succeeded: false, actionType: "PAY" },
    ],
    finalStore: new Set(["budget"]),
  };
  const { valid, violations } = verifyCcpTrace(brokenTrace);
  assert.equal(valid, false, "broken trace should be invalid");
  assert.ok(violations.length > 0, "should report at least one violation");
  assert.ok(violations[0].includes("budget"), "violation mentions the offending phi");

  // Confirm CcpVerificationError wraps violations correctly
  const err = new CcpVerificationError(violations);
  assert.ok(err instanceof Error);
  assert.ok(err.message.includes("budget"));
});

test("replayLog: strict attestation mode throws on policyVersion mismatch", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();
  const action = { kind: "action" as const, type: "PAY", dependsOn: ["approved"] };

  const first = step({
    state: initialState,
    residual: initialResidual,
    input: { evidence: { approved: 0.99 } },
    proposals: [action],
  });

  const tampered = {
    ...first.replay,
    attestation: {
      ...(first.replay.attestation ?? {
        runtimeVersion: "0.1.0",
        schemaVersion: "replay.v2",
        policyVersion: "policy.v1",
      }),
      policyVersion: "policy.v2",
    },
  };
  appendStep(log, tampered);

  assert.throws(
    () =>
      replayLog(log, initialState, initialResidual, [[action]], {
        attestationMode: "strict",
      }),
    (error: unknown) => error instanceof ReplayMismatchError
  );
});

test("replayLog: compatible attestation mode tolerates policyVersion mismatch", () => {
  const initialState = createInitialState();
  const initialResidual = createEmptyResidual();
  const log = createInMemoryLog();
  const action = { kind: "action" as const, type: "PAY", dependsOn: ["approved"] };

  const first = step({
    state: initialState,
    residual: initialResidual,
    input: { evidence: { approved: 0.99 } },
    proposals: [action],
  });

  const tampered = {
    ...first.replay,
    attestation: {
      ...(first.replay.attestation ?? {
        runtimeVersion: "0.1.0",
        schemaVersion: "replay.v2",
        policyVersion: "policy.v1",
      }),
      policyVersion: "policy.v9",
    },
  };
  appendStep(log, tampered);

  const replayed = replayLog(log, initialState, initialResidual, [[action]], {
    attestationMode: "compatible",
  });
  assert.equal(replayed.length, 1);
});
