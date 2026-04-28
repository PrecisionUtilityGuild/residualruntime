import test from "node:test";
import assert from "node:assert/strict";
import { step } from "../runtime/engine";
import { ageOf } from "../runtime/model";
import { createEmptyResidual, createInitialState } from "../runtime/model";

// ── M45-A: ageOf returns undefined when createdAt absent ─────────────────────
test("ageOf: returns undefined when createdAt is absent", () => {
  const gap: { createdAt?: number } = { };
  assert.equal(ageOf(gap, Date.now()), undefined);
});

// ── M45-B: ageOf returns correct elapsed ms ───────────────────────────────────
test("ageOf: returns correct elapsed milliseconds when createdAt is present", () => {
  const t0 = Date.now() - 5000;
  const item = { kind: "tension" as const, phi1: "a", phi2: "b", createdAt: t0 };
  const age = ageOf(item, Date.now());
  assert.ok(age !== undefined);
  assert.ok(age >= 5000, `expected age >= 5000, got ${age}`);
  assert.ok(age < 6000, `expected age < 6000, got ${age}`);
});

// ── M45-C: createdAt stamped on tension entering residual via constraint ───────
test("createdAt: tension introduced via Unresolved constraint gets createdAt stamped", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Unresolved", phi1: "a", phi2: "b" }] },
    proposals: [],
  });
  const tension = result.residualNext.tensions.find((t) => t.phi1 === "a" && t.phi2 === "b");
  assert.ok(tension, "tension should be in residualNext");
  assert.ok(tension!.createdAt !== undefined, "tension should have createdAt");
  assert.ok(tension!.createdAt! <= Date.now(), "createdAt should be <= now");
});

// ── M45-D: createdAt preserved across steps (never reset on carry-forward) ────
test("createdAt: tension createdAt from step 1 is identical in step 2", () => {
  const step1 = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "Unresolved", phi1: "x", phi2: "y" }] },
    proposals: [],
  });

  const t1 = step1.residualNext.tensions.find((t) => t.phi1 === "x");
  assert.ok(t1?.createdAt !== undefined, "createdAt should be set after step 1");

  const step2 = step({
    state: step1.stateNext,
    residual: step1.residualNext,
    input: { constraints: [{ type: "Unresolved", phi1: "x", phi2: "y" }] },
    proposals: [],
  });

  const t2 = step2.residualNext.tensions.find((t) => t.phi1 === "x");
  assert.ok(t2?.createdAt !== undefined, "createdAt should survive step 2");
  assert.equal(t2!.createdAt, t1!.createdAt, "createdAt must not be reset on carry-forward");
});

// ── M45-E: wallClockMs timeout fires correctly ────────────────────────────────
test("wallClockMs: wall-clock timeout fires when tension is old enough", () => {
  // Create a tension with a createdAt 2 seconds in the past
  const pastMs = Date.now() - 2000;
  const residualWithOldTension = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "fast", phi2: "safe", stepsAlive: 0, createdAt: pastMs }],
  };

  const result = step({
    state: createInitialState(),
    residual: residualWithOldTension,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: {
      maxSteps: 999,      // step-count threshold would never fire
      wallClockMs: 1000,  // wall-clock: fires when age >= 1000ms
      resolve: (phi1) => phi1,
    },
    nowMs: Date.now(),
  });

  // Tension should have auto-adjudicated (fast wins)
  assert.equal(result.autoAdjudications.length, 1);
  assert.equal(result.autoAdjudications[0].winner, "fast");
  // Tension should no longer be in residualNext
  assert.equal(result.residualNext.tensions.length, 0);
});

// ── M45-F: maxSteps timeout still works when wallClockMs absent ───────────────
test("wallClockMs absent: maxSteps timeout still fires correctly", () => {
  // Tension has been alive 2 steps, maxSteps = 2
  const residualWithStaleTension = {
    ...createEmptyResidual(),
    tensions: [{ kind: "tension" as const, phi1: "a", phi2: "b", stepsAlive: 2 }],
  };

  const result = step({
    state: createInitialState(),
    residual: residualWithStaleTension,
    input: {},
    proposals: [],
    tensionTimeoutPolicy: {
      maxSteps: 2,
      resolve: (_phi1, phi2) => phi2,
    },
  });

  assert.equal(result.autoAdjudications.length, 1);
  assert.equal(result.autoAdjudications[0].winner, "b");
  assert.equal(result.residualNext.tensions.length, 0);
});

// ── M45-G: createdAt stamped on evidence gap via RequireEvidence constraint ───
test("createdAt: evidence gap introduced via RequireEvidence constraint gets createdAt stamped", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: { constraints: [{ type: "RequireEvidence", phi: "score", threshold: 0.9 }] },
    proposals: [],
  });

  const gap = result.residualNext.evidenceGaps.find((g) => g.phi === "score");
  assert.ok(gap, "evidence gap should be in residualNext");
  assert.ok(gap!.createdAt !== undefined, "gap should have createdAt");
});

// ── M45-H: createdAt stamped on assumption introduced via proposal ────────────
test("createdAt: assumption introduced via proposal gets createdAt stamped", () => {
  const result = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: {},
    proposals: [{ kind: "assumption", phi: "budget_ok", weight: 0.7 }],
  });

  const assumption = result.residualNext.assumptions.find((a) => a.phi === "budget_ok");
  assert.ok(assumption, "assumption should be in residualNext");
  assert.ok(assumption!.createdAt !== undefined, "assumption should have createdAt");
});
