import test from "node:test";
import assert from "node:assert/strict";
import { mergeConstraints, detectConflicts } from "../runtime/constraints";

test("mergeConstraints: deduplicates identical Unresolved tensions", () => {
  const t = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };
  const merged = mergeConstraints([t], [t]);
  const unresolvedCount = merged.filter((c) => c.type === "Unresolved").length;
  assert.equal(unresolvedCount, 1, "duplicate tension collapsed to one");
});

test("mergeConstraints: takes max threshold for duplicate RequireEvidence", () => {
  const a = { type: "RequireEvidence" as const, phi: "budget", threshold: 0.5 };
  const b = { type: "RequireEvidence" as const, phi: "budget", threshold: 0.9 };
  const merged = mergeConstraints([a], [b]);
  const ev = merged.find((c) => c.type === "RequireEvidence" && c.phi === "budget");
  assert.ok(ev && ev.type === "RequireEvidence");
  assert.equal(ev.threshold, 0.9, "max threshold wins");
  assert.equal(merged.filter((c) => c.type === "RequireEvidence").length, 1);
});

test("detectConflicts: flags Prop that is also disputed in Unresolved", () => {
  const constraints = [
    { type: "Prop" as const, phi: "x=true" },
    { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" },
  ];
  const report = detectConflicts(constraints);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].phi, "x=true");
});
