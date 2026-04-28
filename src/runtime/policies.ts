import type { Action, Constraint, Residual, State } from "./model";
import type { ActionCausalAnnotation, DeadlockEvent, OscillationEvent, ResidualLimits, ResidualOverflowEvent, SoftBlockedAction } from "./model";
import { blockingAtoms } from "./predicates";

export function computeFingerprint(residual: Residual): string {
  const tensionParts = residual.tensions
    .map((t) => [t.phi1, t.phi2].sort().join("|"))
    .sort();
  const gapParts = residual.evidenceGaps.map((g) => g.phi).sort();
  const deferredParts = residual.deferred
    .map((d) => {
      const c = d.constraint;
      if (c.type === "Prop") return `D:Prop:${c.phi}`;
      if (c.type === "RequireEvidence") return `D:RE:${c.phi}:${c.threshold}`;
      if (c.type === "Unresolved") return `D:U:${[c.phi1, c.phi2].sort().join("|")}`;
      if (c.type === "Prefer") return `D:Pref:${c.phi}:${c.weight}`;
      if (c.type === "Suspendable") return `D:Sus:${c.phi}:${c.condition}`;
      return `D:?`;
    })
    .sort();
  const assumptionParts = residual.assumptions
    .map((a) => `A:${a.phi}:${a.weight.toFixed(4)}`)
    .sort();
  return [...tensionParts, ...gapParts, ...deferredParts, ...assumptionParts].join(";");
}

export function detectOscillations(
  fingerprint: string,
  history: string[],
  windowSteps: number
): OscillationEvent[] {
  const window = history.slice(-windowSteps);
  const currentStep = history.length;
  const events: OscillationEvent[] = [];
  for (let i = 0; i < window.length; i++) {
    if (window[i] === fingerprint && fingerprint !== "") {
      const firstSeenStep = currentStep - window.length + i;
      events.push({
        kind: "oscillation",
        fingerprint,
        firstSeenStep,
        currentStep,
        cycleLength: currentStep - firstSeenStep,
      });
      break;
    }
  }
  return events;
}

export function computeSoftBlocked(
  actionsApproved: Action[],
  constraints: Constraint[]
): SoftBlockedAction[] {
  const preferences = constraints.filter(
    (c): c is { type: "Prefer"; phi: string; weight: number } => c.type === "Prefer"
  );
  const suspendables = constraints.filter(
    (c): c is { type: "Suspendable"; phi: string; condition: string } => c.type === "Suspendable"
  );
  if (preferences.length === 0 && suspendables.length === 0) return [];
  const result: SoftBlockedAction[] = [];
  for (const action of actionsApproved) {
    const deps = action.dependsOn ?? [];
    const unmet = [
      ...preferences.filter((p) => deps.includes(p.phi)).map((p) => ({ phi: p.phi, weight: p.weight })),
      ...suspendables.filter((s) => deps.includes(s.phi)).map((s) => ({ phi: s.phi, weight: 0 })),
    ];
    if (unmet.length > 0) result.push({ action, unmetPreferences: unmet });
  }
  return result;
}

export function computeOverflows(residualNew: Residual, limits: ResidualLimits | undefined): ResidualOverflowEvent[] {
  const overflows: ResidualOverflowEvent[] = [];
  const checks: Array<{ field: ResidualOverflowEvent["field"]; count: number; limit: number | undefined }> = [
    { field: "tensions", count: residualNew.tensions.length, limit: limits?.maxTensions },
    { field: "evidenceGaps", count: residualNew.evidenceGaps.length, limit: limits?.maxEvidenceGaps },
    { field: "deferred", count: residualNew.deferred.length, limit: limits?.maxDeferred },
    { field: "assumptions", count: residualNew.assumptions.length, limit: limits?.maxAssumptions },
  ];
  for (const check of checks) {
    if (check.limit !== undefined && check.count > check.limit) {
      overflows.push({ kind: "overflow", field: check.field, count: check.count, limit: check.limit });
    }
  }
  return overflows;
}

export function computeDeadlocks(residualNew: Residual, threshold: number): DeadlockEvent[] {
  const deadlocks: DeadlockEvent[] = [];
  for (const t of residualNew.tensions) {
    if ((t.stepsAlive ?? 0) >= threshold) {
      deadlocks.push({
        kind: "deadlock", itemKind: "tension",
        phi: `${t.phi1}|${t.phi2}`,
        stepsStuck: t.stepsAlive ?? 0,
        reason: "tension unresolved beyond threshold",
      });
    }
  }
  for (const d of residualNew.deferred) {
    if ((d.stepsStuck ?? 0) >= threshold) {
      deadlocks.push({
        kind: "deadlock", itemKind: "deferred",
        phi: d.dependencies.join(","),
        stepsStuck: d.stepsStuck ?? 0,
        reason: "deferred dependency unmet beyond threshold",
      });
    }
  }
  for (const g of residualNew.evidenceGaps) {
    if ((g.stepsWithoutEvidence ?? 0) >= threshold) {
      deadlocks.push({
        kind: "deadlock", itemKind: "evidence_gap",
        phi: g.phi,
        stepsStuck: g.stepsWithoutEvidence ?? 0,
        reason: "evidence gap unresolved beyond threshold",
      });
    }
  }
  return deadlocks;
}

export function buildCausalAnnotations(
  allowed: Action[],
  blocked: Action[],
  residual: Residual,
  state: State,
  input: { adjudications?: Array<{ phi1: string; phi2: string; winner: string }> }
): { approvedWith: ActionCausalAnnotation[]; blockedWith: ActionCausalAnnotation[] } {
  const winnerAtoms = (input.adjudications ?? []).map((a) => a.winner);

  const approvedWith: ActionCausalAnnotation[] = allowed.map((action) => ({
    action,
    blockedBy: [],
    enabledBy: (action.dependsOn ?? []).filter((d) => winnerAtoms.includes(d)),
  }));

  const blockedWith: ActionCausalAnnotation[] = blocked.map((action) => ({
    action,
    blockedBy: blockingAtoms(residual, state, action),
    enabledBy: [],
  }));

  return { approvedWith, blockedWith };
}
