// Canonical implementation promoted to src/runtime/verify/ccp0.ts (mission #36).
// This re-export shim preserves backwards compatibility.
export { translateTrace, verifyCcpTrace } from "../runtime/verify/ccp0";
export type { CcpStore, CcpTrace, CcpOp, TellOp, AskOp } from "../runtime/verify/ccp0";
