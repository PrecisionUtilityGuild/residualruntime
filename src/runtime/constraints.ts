import type { Constraint, ConflictReport } from "./model";

export function mergeConstraints(a: Constraint[], b: Constraint[]): Constraint[] {
  const all = [...a, ...b];
  const props = new Map<string, Constraint>();
  const evidenceMax = new Map<string, number>();
  const unresolvedKeys = new Set<string>();
  const unresolvedList: Constraint[] = [];
  const preferMax = new Map<string, number>();
  const suspendableKeys = new Set<string>();
  const suspendableList: Constraint[] = [];

  for (const c of all) {
    if (c.type === "Prop") {
      if (!props.has(c.phi)) props.set(c.phi, c);
    } else if (c.type === "RequireEvidence") {
      const prev = evidenceMax.get(c.phi) ?? -Infinity;
      evidenceMax.set(c.phi, Math.max(prev, c.threshold));
    } else if (c.type === "Unresolved") {
      const key = [c.phi1, c.phi2].sort().join("\0");
      if (!unresolvedKeys.has(key)) {
        unresolvedKeys.add(key);
        unresolvedList.push(c);
      }
    } else if (c.type === "Prefer") {
      const prev = preferMax.get(c.phi) ?? -Infinity;
      preferMax.set(c.phi, Math.max(prev, c.weight));
    } else if (c.type === "Suspendable") {
      const key = `${c.phi}\0${c.condition}`;
      if (!suspendableKeys.has(key)) {
        suspendableKeys.add(key);
        suspendableList.push(c);
      }
    }
  }

  const result: Constraint[] = [
    ...props.values(),
    ...[...evidenceMax.entries()].map(([phi, threshold]) => ({
      type: "RequireEvidence" as const,
      phi,
      threshold,
    })),
    ...unresolvedList,
    ...[...preferMax.entries()].map(([phi, weight]) => ({
      type: "Prefer" as const,
      phi,
      weight,
    })),
    ...suspendableList,
  ];

  return result;
}

export function detectConflicts(constraints: Constraint[]): ConflictReport {
  const unresolvedAtoms = new Set<string>();
  for (const c of constraints) {
    if (c.type === "Unresolved") {
      unresolvedAtoms.add(c.phi1);
      unresolvedAtoms.add(c.phi2);
    }
  }

  const conflicts: Array<{ phi: string; reason: string }> = [];
  for (const c of constraints) {
    if (c.type === "Prop" && unresolvedAtoms.has(c.phi)) {
      conflicts.push({
        phi: c.phi,
        reason: "phi is asserted via Prop but disputed in Unresolved",
      });
    }
  }

  return { conflicts };
}
