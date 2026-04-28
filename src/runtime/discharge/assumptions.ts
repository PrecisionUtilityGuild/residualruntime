import type { Residual, State } from "../model";

export function dischargeAssumptions(residual: Residual, state: State): void {
  residual.assumptions = residual.assumptions.filter((a) => {
    const belief = state.belief[a.phi] ?? 0;
    const isContested = residual.tensions.some((t) => t.phi1 === a.phi || t.phi2 === a.phi);
    if (belief >= a.weight && !isContested) return false;
    if (a.decayPerStep !== undefined) {
      a.weight -= a.decayPerStep;
      if (a.weight <= 0) return false;
    }
    return true;
  });
}
