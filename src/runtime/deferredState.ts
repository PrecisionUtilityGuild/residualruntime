import type { Constraint, Deferred, Residual, State } from "./model";

function normalizedUnresolvedKey(phi1: string, phi2: string): string {
  return [phi1, phi2].sort().join("\0");
}

export function constraintEquals(left: Constraint, right: Constraint): boolean {
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "Prop": {
      const candidate = right as Extract<Constraint, { type: "Prop" }>;
      return left.phi === candidate.phi;
    }
    case "RequireEvidence": {
      const candidate = right as Extract<
        Constraint,
        { type: "RequireEvidence" }
      >;
      return left.phi === candidate.phi && left.threshold === candidate.threshold;
    }
    case "Unresolved": {
      const candidate = right as Extract<Constraint, { type: "Unresolved" }>;
      return (
        normalizedUnresolvedKey(left.phi1, left.phi2) ===
        normalizedUnresolvedKey(candidate.phi1, candidate.phi2)
      );
    }
    case "Prefer": {
      const candidate = right as Extract<Constraint, { type: "Prefer" }>;
      return left.phi === candidate.phi && left.weight === candidate.weight;
    }
    case "Suspendable": {
      const candidate = right as Extract<Constraint, { type: "Suspendable" }>;
      return left.phi === candidate.phi && left.condition === candidate.condition;
    }
  }
}

export function constraintIsExplicitlyMaterialized(
  constraint: Constraint,
  residual: Residual,
  state: State
): boolean {
  if (state.commitments.some((existing) => constraintEquals(existing, constraint))) {
    return true;
  }

  switch (constraint.type) {
    case "Prop":
      return state.commitments.some(
        (existing) => existing.type === "Prop" && existing.phi === constraint.phi
      );
    case "RequireEvidence":
      return false;
    case "Unresolved":
      return residual.tensions.some(
        (tension) =>
          normalizedUnresolvedKey(tension.phi1, tension.phi2) ===
          normalizedUnresolvedKey(constraint.phi1, constraint.phi2)
      );
    case "Prefer":
    case "Suspendable":
      return false;
  }
}

export function constraintIsSatisfiedFromState(
  constraint: Constraint,
  state: State
): boolean {
  switch (constraint.type) {
    case "Prop":
      return state.commitments.some(
        (existing) => existing.type === "Prop" && existing.phi === constraint.phi
      );
    case "RequireEvidence":
      return (state.belief[constraint.phi] ?? 0) >= constraint.threshold;
    default:
      return false;
  }
}

export function constraintIsEffectivelyMaterialized(
  constraint: Constraint,
  residual: Residual,
  state: State
): boolean {
  return (
    constraintIsExplicitlyMaterialized(constraint, residual, state) ||
    constraintIsSatisfiedFromState(constraint, state)
  );
}

export function materializeDeferredConstraint(
  deferred: Deferred,
  residual: Residual,
  state: State
): void {
  const constraint = deferred.constraint;

  if (constraintIsExplicitlyMaterialized(constraint, residual, state)) return;

  switch (constraint.type) {
    case "Unresolved": {
      residual.tensions.push({
        kind: "tension",
        phi1: constraint.phi1,
        phi2: constraint.phi2,
        createdAt: deferred.createdAt ?? Date.now(),
      });
      return;
    }
    default:
      state.commitments.push(constraint);
  }
}

export function pruneMaterializedDeferred(residual: Residual, state: State): void {
  residual.deferred = residual.deferred.filter(
    (deferred) =>
      !constraintIsExplicitlyMaterialized(deferred.constraint, residual, state)
  );
}
