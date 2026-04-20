import test from "node:test";
import assert from "node:assert/strict";
import { step, createEmptyResidual, createInitialState } from "../index";
import { translateTrace, verifyCcpTrace } from "../runtime/verify/ccp0";

// The canonical concrete failure case — same trace as the main test suite:
//   Step 1: tension open, action USE_X_TRUE blocked (failed ask)
//   Step 2: adjudication resolves x=true wins, USE_X_TRUE approved (tell + succeeded ask)
//   Step 3: USE_X_FALSE depends on rejected x=false — blocked (failed ask)
function buildCanonicalTrace() {
  const actionA = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };
  const actionB = { kind: "action" as const, type: "USE_X_FALSE", dependsOn: ["x=false"] };
  const tension = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };

  let state = createInitialState();
  let residual = createEmptyResidual();

  const s1 = step({ state, residual, input: { constraints: [tension] }, proposals: [actionA] });
  state = s1.stateNext; residual = s1.residualNext;

  const s2 = step({
    state,
    residual,
    input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
    proposals: [actionA],
  });
  state = s2.stateNext; residual = s2.residualNext;

  const s3 = step({ state, residual, input: {}, proposals: [actionB] });

  return [s1.replay, s2.replay, s3.replay];
}

test("reencoding: canonical failure case produces a valid CCP₀ trace", () => {
  const events = buildCanonicalTrace();
  const trace = translateTrace(events);
  const result = verifyCcpTrace(trace);

  assert.equal(result.valid, true, `CCP₀ trace is valid. Violations: ${result.violations.join("; ")}`);
  assert.equal(result.violations.length, 0);
});

test("reencoding: step 1 blocking maps to a failed ask on x=true", () => {
  const events = buildCanonicalTrace();
  const trace = translateTrace(events);

  const failedAsks = trace.ops.filter(
    (op) => op.kind === "ask" && !op.succeeded && op.stepIndex === 0
  );

  assert.ok(failedAsks.length > 0, "step 0 (step 1) has at least one failed ask");
  const failedAsk = failedAsks.find((op) => op.kind === "ask" && (op as import("../runtime/verify/ccp0").AskOp).phi === "x=true");
  assert.ok(failedAsk !== undefined, "failed ask is on x=true — the contested atom at step 1");
});

test("reencoding: step 2 adjudication produces tell(x=true)", () => {
  const events = buildCanonicalTrace();
  const trace = translateTrace(events);

  const tellOps = trace.ops.filter(
    (op): op is import("../runtime/verify/ccp0").TellOp => op.kind === "tell" && op.stepIndex === 1
  );

  assert.ok(
    tellOps.some((op) => op.phi === "x=true"),
    "adjudication at step 2 produces tell(x=true) in CCP₀ trace"
  );
});

test("reencoding: verifyCcpTrace returns valid=true on the canonical trace", () => {
  const events = buildCanonicalTrace();
  const { valid, violations } = verifyCcpTrace(translateTrace(events));
  assert.equal(valid, true, violations.join("; "));
});

test("reencoding: monotonicity — no atom told twice in canonical trace", () => {
  const events = buildCanonicalTrace();
  const trace = translateTrace(events);
  const tells = trace.ops.filter((op): op is import("../runtime/verify/ccp0").TellOp => op.kind === "tell");
  const phisSeen = new Set<string>();
  for (const tell of tells) {
    assert.ok(!phisSeen.has(tell.phi), `tell(${tell.phi}) appears more than once — monotonicity violated`);
    phisSeen.add(tell.phi);
  }
});
