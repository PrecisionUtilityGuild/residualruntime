import type { Input, InvalidAdjudicationEvent, Residual, State } from "../model";

// Retract phi from belief, then cascade-retract any phi' whose only support was phi.
// AGM minimal-change: only removes what is no longer supported.
export function contractBelief(state: State, phi: string): void {
  const retracted = new Set<string>();
  const queue = [phi];
  while (queue.length > 0) {
    const target = queue.shift()!;
    if (retracted.has(target)) continue;
    retracted.add(target);
    delete state.belief[target];
    delete state.beliefSupport[target];
    // Cascade: any phi' that listed target as a supporter loses that support.
    for (const [dependent, supporters] of Object.entries(state.beliefSupport)) {
      if (!supporters.includes(target)) continue;
      const remaining = supporters.filter((s) => s !== target);
      if (remaining.length === 0) {
        queue.push(dependent);
      } else {
        state.beliefSupport[dependent] = remaining;
      }
    }
  }
}

export function dischargeTensions(
  residual: Residual,
  input: Input,
  state: State
): InvalidAdjudicationEvent[] {
  const adjudications = input.adjudications ?? [];
  const invalid: InvalidAdjudicationEvent[] = [];

  residual.tensions = residual.tensions.filter((t) => {
    const adj = adjudications.find(
      (a) =>
        (a.phi1 === t.phi1 && a.phi2 === t.phi2) ||
        (a.phi1 === t.phi2 && a.phi2 === t.phi1)
    );
    if (adj) {
      if (adj.winner !== t.phi1 && adj.winner !== t.phi2) {
        invalid.push({
          kind: "invalid_adjudication",
          phi1: t.phi1,
          phi2: t.phi2,
          winner: adj.winner,
          reason: `winner "${adj.winner}" is not a party to the tension between "${t.phi1}" and "${t.phi2}"`,
          source: "manual",
        });
        return true;
      }
      state.commitments.push({ type: "Prop", phi: adj.winner });
      const loser = adj.phi1 === adj.winner ? adj.phi2 : adj.phi1;
      if (!state.rejected.includes(loser)) state.rejected.push(loser);
      contractBelief(state, loser);
      return false;
    }
    t.stepsAlive = (t.stepsAlive ?? 0) + 1;
    return true;
  });

  return invalid;
}
