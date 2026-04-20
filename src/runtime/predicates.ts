import type { Action, Residual, ResidualDelta, State, UnblockAnalysis } from "./model";

export function blocks(residual: Residual, state: State, action: Action): boolean {
  const deps = action.dependsOn ?? [];

  if (residual.tensions.some((t) => deps.includes(t.phi1) || deps.includes(t.phi2))) return true;
  if (residual.evidenceGaps.some((g) => deps.includes(g.phi))) return true;
  if (state.rejected.some((r) => deps.includes(r))) return true;

  return residual.deferred.some((d) => {
    const c = d.constraint;
    let atoms: string[] = [];
    if (c.type === "RequireEvidence") atoms = [c.phi];
    else if (c.type === "Prop") atoms = [c.phi];
    else if (c.type === "Unresolved") atoms = [c.phi1, c.phi2];
    return atoms.some((a) => deps.includes(a));
  });
}

export function blockingAtoms(residual: Residual, state: State, action: Action): string[] {
  const deps = action.dependsOn ?? [];
  const atoms: string[] = [];

  for (const t of residual.tensions) {
    if (deps.includes(t.phi1)) atoms.push(t.phi1);
    if (deps.includes(t.phi2)) atoms.push(t.phi2);
  }
  for (const g of residual.evidenceGaps) {
    if (deps.includes(g.phi)) atoms.push(g.phi);
  }
  for (const r of state.rejected) {
    if (deps.includes(r)) atoms.push(r);
  }
  for (const d of residual.deferred) {
    const c = d.constraint;
    let dAtoms: string[] = [];
    if (c.type === "RequireEvidence") dAtoms = [c.phi];
    else if (c.type === "Prop") dAtoms = [c.phi];
    else if (c.type === "Unresolved") dAtoms = [c.phi1, c.phi2];
    for (const a of dAtoms) {
      if (deps.includes(a)) atoms.push(a);
    }
  }
  return [...new Set(atoms)];
}

type DeltaCandidate =
  | { kind: "adjudicate-tension"; phi1: string; phi2: string; winner: string }
  | { kind: "satisfy-evidence-gap"; phi: string; requiredBelief: number }
  | { kind: "commit-deferred-dependency"; phi: string };

function applyDelta(delta: DeltaCandidate, residual: Residual, state: State): { residual: Residual; state: State } {
  const r: Residual = { ...residual, tensions: [...residual.tensions], evidenceGaps: [...residual.evidenceGaps], deferred: [...residual.deferred], assumptions: [...residual.assumptions] };
  const s: State = { ...state, belief: { ...state.belief }, rejected: [...state.rejected] };

  if (delta.kind === "adjudicate-tension") {
    const loser = delta.winner === delta.phi1 ? delta.phi2 : delta.phi1;
    r.tensions = r.tensions.filter((t) => !(t.phi1 === delta.phi1 && t.phi2 === delta.phi2));
    s.belief[delta.winner] = Math.max(s.belief[delta.winner] ?? 0, 1);
    if (!s.rejected.includes(loser)) s.rejected = [...s.rejected, loser];
  } else if (delta.kind === "satisfy-evidence-gap") {
    r.evidenceGaps = r.evidenceGaps.filter((g) => g.phi !== delta.phi);
    s.belief[delta.phi] = Math.max(s.belief[delta.phi] ?? 0, delta.requiredBelief);
  } else if (delta.kind === "commit-deferred-dependency") {
    r.deferred = r.deferred.filter((d) => {
      const c = d.constraint;
      if (c.type === "Prop") return c.phi !== delta.phi;
      if (c.type === "RequireEvidence") return c.phi !== delta.phi;
      if (c.type === "Unresolved") return c.phi1 !== delta.phi && c.phi2 !== delta.phi;
      return true;
    });
  }

  return { residual: r, state: s };
}

export function whatWouldUnblock(
  action: Action,
  residual: Residual,
  state: State
): UnblockAnalysis {
  const deps = action.dependsOn ?? [];

  // Permanently blocked: a rejected atom can never be un-rejected.
  if (deps.some((d) => state.rejected.includes(d))) return { permanent: true, deltas: [] };

  const candidates: DeltaCandidate[] = [];
  const seen = new Set<string>();

  const add = (key: string, delta: DeltaCandidate) => {
    if (!seen.has(key)) { seen.add(key); candidates.push(delta); }
  };

  for (const t of residual.tensions) {
    if (deps.includes(t.phi1) || deps.includes(t.phi2)) {
      add(`tension:${t.phi1}:${t.phi2}:${t.phi1}`, { kind: "adjudicate-tension", phi1: t.phi1, phi2: t.phi2, winner: t.phi1 });
      add(`tension:${t.phi1}:${t.phi2}:${t.phi2}`, { kind: "adjudicate-tension", phi1: t.phi1, phi2: t.phi2, winner: t.phi2 });
    }
  }

  for (const g of residual.evidenceGaps) {
    if (deps.includes(g.phi)) {
      add(`gap:${g.phi}`, { kind: "satisfy-evidence-gap", phi: g.phi, requiredBelief: g.threshold });
    }
  }

  for (const d of residual.deferred) {
    const c = d.constraint;
    let dAtoms: string[] = [];
    if (c.type === "Prop") dAtoms = [c.phi];
    else if (c.type === "RequireEvidence") dAtoms = [c.phi];
    else if (c.type === "Unresolved") dAtoms = [c.phi1, c.phi2];
    for (const a of dAtoms) {
      if (deps.includes(a)) {
        add(`deferred:${a}`, { kind: "commit-deferred-dependency", phi: a });
      }
    }
  }

  const deltas = candidates.map((delta) => {
    const { residual: r, state: s } = applyDelta(delta, residual, state);
    return { ...delta, sufficient: !blocks(r, s, action) } as ResidualDelta;
  });

  return { permanent: false, deltas };
}

export function filterBlocked(
  actionsCandidate: Action[],
  residualNew: Residual,
  stateNext: State
): { allowed: Action[]; blocked: Action[] } {
  const allowed: Action[] = [];
  const blocked: Action[] = [];
  for (const action of actionsCandidate) {
    if (blocks(residualNew, stateNext, action)) blocked.push(action);
    else allowed.push(action);
  }
  return { allowed, blocked };
}
