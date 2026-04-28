import type { Deferred, Residual, State } from "../model";
import {
  constraintIsExplicitlyMaterialized,
  constraintIsSatisfiedFromState,
  materializeDeferredConstraint,
} from "../deferredState";

function dependencyStillUnresolved(dep: string, residual: Residual, state: State, d: Deferred): boolean {
  if (dep.startsWith("evidence:")) {
    const phi = dep.replace("evidence:", "");
    if (d.constraint.type === "RequireEvidence" && d.constraint.phi === phi) {
      return (state.belief[phi] ?? 0) < d.constraint.threshold;
    }
    return (state.belief[phi] ?? 0) <= 0;
  }

  if (state.rejected.includes(dep)) return true;
  if (residual.tensions.some((t) => t.phi1 === dep || t.phi2 === dep)) return true;
  if (residual.evidenceGaps.some((gap) => gap.phi === dep)) return true;
  if (
    residual.deferred.some(
      (other) =>
        other !== d &&
        other.constraint.type === "Prop" &&
        other.constraint.phi === dep
    )
  ) {
    return true;
  }

  return !state.commitments.some((constraint) => constraint.type === "Prop" && constraint.phi === dep);
}

export function dischargeDeferred(residual: Residual, state: State): void {
  residual.deferred = residual.deferred.filter((d) => {
    if (constraintIsExplicitlyMaterialized(d.constraint, residual, state)) {
      return false;
    }

    const unresolvedDep = d.dependencies.some((dep) => dependencyStillUnresolved(dep, residual, state, d));

    if (!unresolvedDep || constraintIsSatisfiedFromState(d.constraint, state)) {
      materializeDeferredConstraint(d, residual, state);
      return false;
    }
    d.stepsStuck = (d.stepsStuck ?? 0) + 1;
    return true;
  });
}
