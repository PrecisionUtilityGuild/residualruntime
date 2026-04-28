import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { step } from "../runtime/engine";
import { createFileLog } from "../runtime/fileAdapter";
import {
  createEmptyResidual,
  createInitialState,
  type Action,
  type EventContext,
  type Input,
  type Proposal,
  type ReplayAttestation,
  type ReplayEvent,
  type Residual,
  type ResidualLimits,
  type SessionMetadata,
  type SessionMetadataInput,
  type SessionArbitrationEvent,
  type SessionArbitrationPolicy,
  type SessionConflictEvent,
  type SessionConflictScope,
  type State,
  type StepResult,
  type TensionTimeoutPolicy,
} from "../runtime/model";
import {
  arbitrateSessionConflicts,
  resolveSessionArbitrationPolicy,
  type SessionArbitrationPolicyInput,
} from "./arbitration";
import { computeFingerprint } from "../runtime/policies";
import { blocks } from "../runtime/predicates";
import { readLog } from "../runtime/store";

const SESSION_FILE_EXT = ".ndjson";
const SESSION_METADATA_FILE_EXT = ".meta.json";
const SESSION_DB_FILENAME = "sessions.sqlite";
const DEFAULT_RESOURCE_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type StepSessionRequest = {
  input?: Input;
  proposals?: Proposal[];
  context?: EventContext;
  arbitrationPolicy?: SessionArbitrationPolicyInput;
  tensionTimeoutPolicy?: TensionTimeoutPolicy;
  deadlockThreshold?: number;
  residualLimits?: ResidualLimits;
  nowMs?: number;
};

export type UpdateSessionRequest = {
  metadata?: {
    objectiveType?: string;
    objectiveRef?: string;
    title?: string;
    status?: "active" | "closed";
    closedAt?: number;
  };
  releaseResourceClaims?: boolean;
};

export type SessionSnapshot = {
  sessionId: string;
  state: State;
  residual: Residual;
  stepCount: number;
  metadata: SessionMetadata;
  heldResourceClaims: Action[];
  lastEventContext?: EventContext;
  lastReplayAttestation?: ReplayAttestation;
};

export type SessionListItem = {
  sessionId: string;
  stepCount: number;
  metadata: SessionMetadata;
  heldResourceClaimCount: number;
  lastEventContext?: EventContext;
  lastReplayAttestation?: ReplayAttestation;
};

export type SessionReplaySnapshot = {
  sessionId: string;
  events: ReplayEvent[];
};

export type LegacyImportResult = {
  databasePath: string;
  scanned: number;
  imported: number;
  skippedExisting: number;
  importedEvents: number;
};

type SessionRecord = {
  sessionId: string;
  state: State;
  residual: Residual;
  stepCount: number;
  fingerprintHistory: string[];
  activeRevocable: Action[];
  operationFingerprints: Record<string, string>;
  heldResourceClaims: Action[];
  heldResourceClaimLeases: Record<string, ResourceClaimLease>;
  metadata: SessionMetadata;
  lastEventContext?: EventContext;
  lastReplayAttestation?: ReplayAttestation;
};

type PersistedSession = {
  sessionId: string;
  metadata: SessionMetadata;
  stepCount: number;
  heldResourceClaimCount: number;
  lastEventContext?: EventContext;
  lastReplayAttestation?: ReplayAttestation;
};

type SessionEnvelope = {
  metadata: SessionMetadata;
  heldResourceClaims: Action[];
  heldResourceClaimLeases?: Record<string, ResourceClaimLease>;
};

type ResourceClaimLease = {
  claimId: string;
  leaseUntil: number;
  renewedAt: number;
  claimVersion: number;
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`);
  return `{${entries.join(",")}}`;
}

function actionKey(action: Action): string {
  return JSON.stringify({
    kind: action.kind,
    type: action.type,
    operationId: action.operationId?.trim() || undefined,
    riskTier: action.riskTier ?? "medium",
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    revocable: action.revocable === true,
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
  });
}

function actionOperationFingerprint(action: Action): string {
  return stableSerialize({
    type: action.type,
    riskTier: action.riskTier ?? "medium",
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    revocable: action.revocable === true,
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
  });
}

function isAction(value: unknown): value is Action {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "action" || typeof candidate.type !== "string") {
    return false;
  }
  if (
    candidate.operationId !== undefined &&
    (typeof candidate.operationId !== "string" || candidate.operationId.trim().length === 0)
  ) {
    return false;
  }

  if (
    candidate.riskTier !== undefined &&
    candidate.riskTier !== "low" &&
    candidate.riskTier !== "medium" &&
    candidate.riskTier !== "high" &&
    candidate.riskTier !== "critical"
  ) {
    return false;
  }

  const arrayFields = ["dependsOn", "readSet", "writeSet"] as const;
  for (const field of arrayFields) {
    const fieldValue = candidate[field];
    if (
      fieldValue !== undefined &&
      (!Array.isArray(fieldValue) ||
        fieldValue.some((item) => typeof item !== "string"))
    ) {
      return false;
    }
  }

  if (
    candidate.revocable !== undefined &&
    typeof candidate.revocable !== "boolean"
  ) {
    return false;
  }

  return true;
}

function isResourceAction(action: Action): boolean {
  return normalizeResourceSet(action.readSet).length > 0 ||
    normalizeResourceSet(action.writeSet).length > 0;
}

function mergeHeldResourceClaims(current: Action[], approved: Action[]): Action[] {
  const next = current
    .filter(isResourceAction)
    .map((action) => deepClone(action));
  const seen = new Set(next.map(actionKey));

  for (const action of approved) {
    if (!isResourceAction(action)) continue;
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(deepClone(action));
  }

  return next;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function nextClaimLease(
  current: Record<string, ResourceClaimLease>,
  action: Action,
  nowMs: number,
  leaseMs: number
): ResourceClaimLease {
  const key = actionKey(action);
  const previous = current[key];
  return {
    claimId: previous?.claimId ?? randomUUID(),
    leaseUntil: nowMs + leaseMs,
    renewedAt: nowMs,
    claimVersion: (previous?.claimVersion ?? 0) + 1,
  };
}

function pruneExpiredClaims(
  claims: Action[],
  leases: Record<string, ResourceClaimLease>,
  nowMs: number
): { claims: Action[]; leases: Record<string, ResourceClaimLease> } {
  const nextClaims: Action[] = [];
  const nextLeases: Record<string, ResourceClaimLease> = {};
  for (const claim of claims) {
    const key = actionKey(claim);
    const lease = leases[key];
    if (!lease) continue;
    if (lease.leaseUntil < nowMs) continue;
    nextClaims.push(claim);
    nextLeases[key] = lease;
  }
  return { claims: nextClaims, leases: nextLeases };
}

function mergeClaimState(params: {
  currentClaims: Action[];
  currentLeases: Record<string, ResourceClaimLease>;
  approvedActions: Action[];
  nowMs: number;
  leaseMs: number;
}): { claims: Action[]; leases: Record<string, ResourceClaimLease> } {
  const seeded = pruneExpiredClaims(
    params.currentClaims,
    params.currentLeases,
    params.nowMs
  );
  const nextClaims = mergeHeldResourceClaims(seeded.claims, params.approvedActions);
  const nextLeases: Record<string, ResourceClaimLease> = {};
  for (const claim of nextClaims) {
    nextLeases[actionKey(claim)] = nextClaimLease(
      { ...seeded.leases, ...nextLeases },
      claim,
      params.nowMs,
      params.leaseMs
    );
  }
  return { claims: nextClaims, leases: nextLeases };
}

function normalizeResourceSet(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(normalized)].sort();
}

function toResourceSet(values?: string[]): Set<string> {
  return new Set(normalizeResourceSet(values));
}

function intersectResources(a: Set<string>, b: Set<string>): string[] {
  const overlap: string[] = [];
  for (const value of a) {
    if (b.has(value)) overlap.push(value);
  }
  return overlap.sort();
}

function resolveSharedScope(
  left?: EventContext,
  right?: EventContext
): SessionConflictScope | undefined {
  if (!left || !right) return undefined;
  if (left.worktreeId && right.worktreeId && left.worktreeId === right.worktreeId) {
    return { kind: "worktree", value: left.worktreeId };
  }
  if (left.branch && right.branch && left.branch === right.branch) {
    return { kind: "branch", value: left.branch };
  }
  return undefined;
}

type ScopedPeerAction = {
  sessionId: string;
  action: Action;
  scope: SessionConflictScope;
  metadata: SessionMetadata;
  lease: ResourceClaimLease;
};

function sessionConflictKey(conflict: {
  conflictType: "write_write" | "read_write";
  resource: string;
  otherSessionId: string;
}): string {
  return `${conflict.conflictType}|${conflict.resource}|${conflict.otherSessionId}`;
}

function isSessionStepConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unique constraint failed") &&
    message.includes("session_events.session_id") &&
    message.includes("session_events.step_index")
  );
}

function reconcileRevocableActions(
  current: Action[],
  approved: Action[],
  residual: Residual,
  state: State
): Action[] {
  const survivors = current.filter((action) => !blocks(residual, state, action));
  const next = [...survivors];
  const seen = new Set(next.map(actionKey));

  for (const action of approved) {
    if (action.revocable !== true) continue;
    const key = actionKey(action);
    if (!seen.has(key)) {
      seen.add(key);
      next.push(action);
    }
  }

  return next;
}

function toSessionMetadataFilename(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}${SESSION_METADATA_FILE_EXT}`;
}

function fromSessionFilename(fileName: string): string {
  return decodeURIComponent(basename(fileName, SESSION_FILE_EXT));
}

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSessionMetadata(input?: SessionMetadataInput): SessionMetadata {
  const objectiveType = trimToOptionalString(input?.objectiveType);
  const objectiveRef = trimToOptionalString(input?.objectiveRef);
  const title = trimToOptionalString(input?.title);
  const createdAt = input?.createdAt ?? Date.now();
  const status = input?.status ?? "active";
  const closedAt = input?.closedAt ?? (status === "closed" ? createdAt : undefined);

  return {
    objectiveType,
    objectiveRef,
    title,
    status,
    createdAt,
    closedAt,
  };
}

function parseSessionMetadata(raw: unknown): SessionMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const status = candidate.status;
  const createdAt = candidate.createdAt;

  if ((status !== "active" && status !== "closed") || typeof createdAt !== "number") {
    return undefined;
  }

  const metadata: SessionMetadata = {
    objectiveType: trimToOptionalString(candidate.objectiveType),
    objectiveRef: trimToOptionalString(candidate.objectiveRef),
    title: trimToOptionalString(candidate.title),
    status,
    createdAt,
    closedAt:
      typeof candidate.closedAt === "number"
        ? candidate.closedAt
        : status === "closed"
          ? createdAt
          : undefined,
  };

  return metadata;
}

function parseHeldResourceClaims(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAction).filter(isResourceAction).map((action) => deepClone(action));
}

function parseSessionEnvelope(raw: unknown): SessionEnvelope | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const candidate = raw as Record<string, unknown>;
  if ("metadata" in candidate) {
    const metadata = parseSessionMetadata(candidate.metadata);
    if (!metadata) return undefined;
    return {
      metadata,
      heldResourceClaims: parseHeldResourceClaims(candidate.heldResourceClaims),
      heldResourceClaimLeases:
        typeof candidate.heldResourceClaimLeases === "object" &&
        candidate.heldResourceClaimLeases !== null
          ? (candidate.heldResourceClaimLeases as Record<string, ResourceClaimLease>)
          : {},
    };
  }

  const metadata = parseSessionMetadata(raw);
  if (!metadata) return undefined;
  return {
    metadata,
    heldResourceClaims: [],
    heldResourceClaimLeases: {},
  };
}

function serializeSessionEnvelope(envelope: SessionEnvelope): string {
  return JSON.stringify({
    metadata: envelope.metadata,
    heldResourceClaims: envelope.heldResourceClaims,
    heldResourceClaimLeases: envelope.heldResourceClaimLeases ?? {},
  });
}

function parseEventContext(raw: unknown): EventContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const context = raw as Record<string, unknown>;
  const branch = trimToOptionalString(context.branch);
  const commitSha = trimToOptionalString(context.commitSha);
  const worktreeId = trimToOptionalString(context.worktreeId);
  const actorId = trimToOptionalString(context.actorId);

  if (!branch && !commitSha && !worktreeId && !actorId) return undefined;

  return {
    ...(branch ? { branch } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(actorId ? { actorId } : {}),
  };
}

function readSessionMetadata(path: string): SessionMetadata | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseSessionMetadata(raw);
  } catch {
    return undefined;
  }
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function applySessionMetadataPatch(
  current: SessionMetadata,
  patch?: UpdateSessionRequest["metadata"]
): SessionMetadata {
  if (!patch) return deepClone(current);

  const status = patch.status ?? current.status;
  const closedAt =
    status === "closed"
      ? patch.closedAt ?? current.closedAt ?? Date.now()
      : undefined;

  if (closedAt !== undefined && closedAt < current.createdAt) {
    throw new Error("closedAt cannot be earlier than createdAt");
  }

  return {
    objectiveType:
      patch.objectiveType !== undefined
        ? trimToOptionalString(patch.objectiveType)
        : current.objectiveType,
    objectiveRef:
      patch.objectiveRef !== undefined
        ? trimToOptionalString(patch.objectiveRef)
        : current.objectiveRef,
    title:
      patch.title !== undefined ? trimToOptionalString(patch.title) : current.title,
    status,
    createdAt: current.createdAt,
    closedAt,
  };
}

function resolveSessionRootDir(rootDir?: string): string {
  const explicitRoot = rootDir?.trim();
  const envRoot = process.env.RESIDUAL_SESSION_ROOT_DIR?.trim();
  const home = process.env.HOME?.trim();

  const candidates = uniquePreservingOrder(
    [
      explicitRoot,
      envRoot,
      join(process.cwd(), ".residual-sessions"),
      home ? join(home, ".codex", "residual-runtime", "sessions") : undefined,
      join(tmpdir(), "residual-runtime-sessions"),
    ]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
  );

  let lastError: unknown = undefined;
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  const suffix =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Unable to initialize residual session directory. Tried: ${candidates.join(", ")}.${suffix}`
  );
}

class SessionSqliteStore {
  private readonly databasePath: string;
  private readonly db: InstanceType<typeof Database>;

  constructor(rootDir: string) {
    this.databasePath = join(rootDir, SESSION_DB_FILENAME);
    this.db = new Database(this.databasePath);
    this.initializeSchema();
  }

  get path(): string {
    return this.databasePath;
  }

  private initializeSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        UNIQUE(session_id, step_index)
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session_step
      ON session_events(session_id, step_index);

      CREATE INDEX IF NOT EXISTS idx_session_events_recorded_at
      ON session_events(recorded_at);
    `);
  }

  sessionExists(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 as ok FROM sessions WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { ok: number } | undefined;
    return row !== undefined;
  }

  createSession(sessionId: string, metadata: SessionMetadata): void {
    const nowMs = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions(session_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        sessionId,
        serializeSessionEnvelope({
          metadata,
          heldResourceClaims: [],
          heldResourceClaimLeases: {},
        }),
        nowMs,
        nowMs
      );
  }

  getSessionEnvelope(sessionId: string): SessionEnvelope | undefined {
    const row = this.db
      .prepare("SELECT metadata_json FROM sessions WHERE session_id = ?")
      .get(sessionId) as { metadata_json: string } | undefined;

    if (!row) return undefined;

    try {
      return (
        parseSessionEnvelope(JSON.parse(row.metadata_json)) ?? {
          metadata: normalizeSessionMetadata(),
          heldResourceClaims: [],
        }
      );
    } catch {
      return {
        metadata: normalizeSessionMetadata(),
        heldResourceClaims: [],
      };
    }
  }

  readSessionEvents(sessionId: string): ReplayEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_json
         FROM session_events
         WHERE session_id = ?
         ORDER BY step_index ASC`
      )
      .all(sessionId) as Array<{ event_json: string }>;

    const events: ReplayEvent[] = [];
    for (const row of rows) {
      events.push(JSON.parse(row.event_json) as ReplayEvent);
    }
    return events;
  }

  appendSessionEvent(
    sessionId: string,
    stepIndex: number,
    event: ReplayEvent,
    metadata: SessionMetadata,
    heldResourceClaims: Action[],
    heldResourceClaimLeases: Record<string, ResourceClaimLease>
  ): void {
    const nowMs = Date.now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO session_events(session_id, step_index, recorded_at, event_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(sessionId, stepIndex, nowMs, JSON.stringify(event));

      this.db
        .prepare(
          "UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE session_id = ?"
        )
        .run(
          serializeSessionEnvelope({
            metadata,
            heldResourceClaims,
            heldResourceClaimLeases,
          }),
          nowMs,
          sessionId
        );

      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  updateSession(
    sessionId: string,
    metadata: SessionMetadata,
    heldResourceClaims: Action[],
    heldResourceClaimLeases: Record<string, ResourceClaimLease>
  ): void {
    const nowMs = Date.now();
    this.db
      .prepare(
        "UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE session_id = ?"
      )
      .run(
        serializeSessionEnvelope({
          metadata,
          heldResourceClaims,
          heldResourceClaimLeases,
        }),
        nowMs,
        sessionId
      );
  }

  listSessions(): PersistedSession[] {
    const rows = this.db
      .prepare(
        `SELECT
            s.session_id,
            s.metadata_json,
            COALESCE(MAX(e.step_index) + 1, 0) as step_count,
            (
              SELECT e2.event_json
              FROM session_events e2
              WHERE e2.session_id = s.session_id
              ORDER BY e2.step_index DESC
              LIMIT 1
            ) as last_event_json
         FROM sessions s
         LEFT JOIN session_events e ON e.session_id = s.session_id
         GROUP BY s.session_id, s.metadata_json
         ORDER BY s.session_id ASC`
      )
      .all() as Array<{
      session_id: string;
      metadata_json: string;
      step_count: number;
      last_event_json: string | null;
    }>;

    return rows.map((row) => {
      let envelope: SessionEnvelope = {
        metadata: normalizeSessionMetadata(),
        heldResourceClaims: [],
      };
      try {
        envelope = parseSessionEnvelope(JSON.parse(row.metadata_json)) ?? envelope;
      } catch {
        // Keep normalized fallback.
      }

      let lastEventContext: EventContext | undefined = undefined;
      let lastReplayAttestation: ReplayAttestation | undefined = undefined;
      if (row.last_event_json) {
        try {
          const event = JSON.parse(row.last_event_json) as ReplayEvent;
          lastEventContext = parseEventContext(event.context);
          lastReplayAttestation = event.attestation;
        } catch {
          lastEventContext = undefined;
          lastReplayAttestation = undefined;
        }
      }

      return {
        sessionId: row.session_id,
        metadata: envelope.metadata,
        stepCount: Number(row.step_count),
        heldResourceClaimCount: envelope.heldResourceClaims.length,
        lastEventContext,
        lastReplayAttestation,
      };
    });
  }

  importLegacyNdjson(rootDir: string): LegacyImportResult {
    const files = readdirSync(rootDir).filter((name) => extname(name) === SESSION_FILE_EXT);

    let imported = 0;
    let skippedExisting = 0;
    let importedEvents = 0;

    for (const fileName of files) {
      const sessionId = fromSessionFilename(fileName);
      if (this.sessionExists(sessionId)) {
        skippedExisting += 1;
        continue;
      }

      const sessionPath = join(rootDir, fileName);
      const metadataPath = join(rootDir, toSessionMetadataFilename(sessionId));
      const metadata = readSessionMetadata(metadataPath) ?? normalizeSessionMetadata();

      const events = readLog(createFileLog(sessionPath));

      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.createSession(sessionId, metadata);

        const insertEvent = this.db.prepare(
          `INSERT INTO session_events(session_id, step_index, recorded_at, event_json)
           VALUES (?, ?, ?, ?)`
        );
        const nowMs = Date.now();

        for (let i = 0; i < events.length; i++) {
          insertEvent.run(sessionId, i, nowMs, JSON.stringify(events[i]));
        }

        this.db
          .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
          .run(nowMs, sessionId);

        this.db.exec("COMMIT;");

        imported += 1;
        importedEvents += events.length;
      } catch (error: unknown) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }

    return {
      databasePath: this.databasePath,
      scanned: files.length,
      imported,
      skippedExisting,
      importedEvents,
    };
  }

  getJournalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    return row?.journal_mode ?? "";
  }
}

export class SessionManager {
  private readonly rootDir: string;
  private readonly store: SessionSqliteStore;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly defaultArbitrationPolicy: SessionArbitrationPolicy;
  private readonly claimLeaseMs: number;

  constructor(rootDir?: string) {
    this.rootDir = resolveSessionRootDir(rootDir);
    this.store = new SessionSqliteStore(this.rootDir);
    this.defaultArbitrationPolicy = resolveSessionArbitrationPolicy();
    this.claimLeaseMs = parsePositiveIntEnv(
      "RESIDUAL_SESSION_CLAIM_LEASE_MS",
      DEFAULT_RESOURCE_CLAIM_LEASE_MS
    );
  }

  private resolveArbitrationPolicy(
    override?: SessionArbitrationPolicyInput
  ): SessionArbitrationPolicy {
    return resolveSessionArbitrationPolicy({
      enabled: override?.enabled ?? this.defaultArbitrationPolicy.enabled,
      defaultMode:
        override?.defaultMode ?? this.defaultArbitrationPolicy.defaultMode,
      modeByConflictType: {
        ...this.defaultArbitrationPolicy.modeByConflictType,
        ...(override?.modeByConflictType ?? {}),
      },
      objectiveTypePriority: {
        ...this.defaultArbitrationPolicy.objectiveTypePriority,
        ...(override?.objectiveTypePriority ?? {}),
      },
    });
  }

  private loadSession(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    if (!this.store.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const envelope =
      this.store.getSessionEnvelope(sessionId) ?? {
        metadata: normalizeSessionMetadata(),
        heldResourceClaims: [],
        heldResourceClaimLeases: {},
      };
    const metadata = envelope.metadata;
    const events = this.store.readSessionEvents(sessionId);

    let state = createInitialState();
    let residual = createEmptyResidual();
    let fingerprintHistory: string[] = [];
    let activeRevocable: Action[] = [];
    const operationFingerprints: Record<string, string> = {};
    const prunedClaims = pruneExpiredClaims(
      deepClone(envelope.heldResourceClaims),
      deepClone(envelope.heldResourceClaimLeases ?? {}),
      Date.now()
    );
    const heldResourceClaims = prunedClaims.claims;
    const heldResourceClaimLeases = prunedClaims.leases;
    let lastEventContext: EventContext | undefined = undefined;
    let lastReplayAttestation: ReplayAttestation | undefined = undefined;

    for (const event of events) {
      state = deepClone(event.after.state);
      residual = deepClone(event.after.residual);
      fingerprintHistory = [...fingerprintHistory, computeFingerprint(residual)];
      activeRevocable = reconcileRevocableActions(activeRevocable, event.approvedActions, residual, state);
      for (const action of event.approvedActions) {
        const operationId = action.operationId?.trim();
        if (!operationId) continue;
        operationFingerprints[operationId] = actionOperationFingerprint(action);
      }
      if (event.context) {
        lastEventContext = deepClone(event.context);
      }
      if (event.attestation) {
        lastReplayAttestation = deepClone(event.attestation);
      }
    }

    const session: SessionRecord = {
      sessionId,
      state,
      residual,
      stepCount: events.length,
      fingerprintHistory,
      activeRevocable,
      operationFingerprints,
      heldResourceClaims,
      heldResourceClaimLeases,
      metadata,
      lastEventContext,
      lastReplayAttestation,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  newSession(options?: {
    sessionId?: string;
    metadata?: SessionMetadataInput;
    seedInput?: Input;
    seedProposals?: Proposal[];
    stepOptions?: Omit<StepSessionRequest, "input" | "proposals">;
  }): SessionSnapshot {
    const sessionId = options?.sessionId?.trim() || randomUUID();

    if (this.store.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" already exists`);
    }

    const metadata = normalizeSessionMetadata(options?.metadata);
    this.store.createSession(sessionId, metadata);

    const record: SessionRecord = {
      sessionId,
      state: createInitialState(),
      residual: createEmptyResidual(),
      stepCount: 0,
      fingerprintHistory: [],
      activeRevocable: [],
      operationFingerprints: {},
      heldResourceClaims: [],
      heldResourceClaimLeases: {},
      metadata,
      lastEventContext: undefined,
      lastReplayAttestation: undefined,
    };

    this.sessions.set(sessionId, record);

    const seedInput = options?.seedInput;
    const seedProposals = options?.seedProposals;
    if (
      (seedInput !== undefined && Object.keys(seedInput).length > 0) ||
      (seedProposals !== undefined && seedProposals.length > 0)
    ) {
      this.stepSession(sessionId, {
        input: seedInput,
        proposals: seedProposals,
        ...options?.stepOptions,
      });
    }

    return this.getState(sessionId);
  }

  private listScopedPeerActions(
    sessionId: string,
    context?: EventContext,
    nowMs: number = Date.now()
  ): ScopedPeerAction[] {
    if (!context) return [];

    const peers = this.store
      .listSessions()
      .filter(
        (item) => item.sessionId !== sessionId && item.metadata.status === "active"
      );

    const scoped: ScopedPeerAction[] = [];
    for (const peer of peers) {
      const loaded = this.loadSession(peer.sessionId);
      const scope = resolveSharedScope(context, loaded.lastEventContext);
      if (!scope) continue;

      const pruned = pruneExpiredClaims(
        loaded.heldResourceClaims,
        loaded.heldResourceClaimLeases,
        nowMs
      );
      loaded.heldResourceClaims = pruned.claims;
      loaded.heldResourceClaimLeases = pruned.leases;
      for (const action of loaded.heldResourceClaims) {
        const lease = loaded.heldResourceClaimLeases[actionKey(action)];
        if (!lease) continue;
        const readSet = normalizeResourceSet(action.readSet);
        const writeSet = normalizeResourceSet(action.writeSet);
        if (readSet.length === 0 && writeSet.length === 0) continue;
        scoped.push({
          sessionId: loaded.sessionId,
          action: deepClone(action),
          scope: deepClone(scope),
          metadata: deepClone(loaded.metadata),
          lease: deepClone(lease),
        });
      }
    }

    return scoped.sort((left, right) => {
      if (left.sessionId !== right.sessionId) {
        return left.sessionId.localeCompare(right.sessionId);
      }
      return actionKey(left.action).localeCompare(actionKey(right.action));
    });
  }

  private detectConflictsForAction(
    action: Action,
    scopedPeers: ScopedPeerAction[],
    nowMs: number
  ): SessionConflictEvent[] {
    const readSet = toResourceSet(action.readSet);
    const writeSet = toResourceSet(action.writeSet);
    if (readSet.size === 0 && writeSet.size === 0) return [];

    const conflicts: SessionConflictEvent[] = [];
    const seen = new Set<string>();

    const addConflict = (
      peer: ScopedPeerAction,
      conflictType: "write_write" | "read_write",
      resource: string,
      reason: string
    ) => {
      const key = `${conflictType}|${resource}|${peer.sessionId}|${actionKey(peer.action)}`;
      if (seen.has(key)) return;
      seen.add(key);
      conflicts.push({
        kind: "session_conflict",
        action: deepClone(action),
        otherAction: deepClone(peer.action),
        otherSessionId: peer.sessionId,
        conflictType,
        resource,
        scope: deepClone(peer.scope),
        reason,
        unblock: [
          {
            kind: "wait_for_other_session",
            detail: `Wait until session "${peer.sessionId}" releases resource "${resource}" in ${peer.scope.kind} "${peer.scope.value}".`,
          },
          {
            kind: "split_scope",
            detail: `Move one objective to a different ${peer.scope.kind} or worktree so both actions can run independently.`,
          },
          {
            kind: "narrow_resource_sets",
            detail: `Reduce overlapping readSet/writeSet entries for "${resource}".`,
          },
        ],
      });
    };

    for (const peer of scopedPeers) {
      const peerReadSet = toResourceSet(peer.action.readSet);
      const peerWriteSet = toResourceSet(peer.action.writeSet);

      for (const resource of intersectResources(writeSet, peerWriteSet)) {
        addConflict(
          peer,
          "write_write",
          resource,
          `Action "${action.type}" writes "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" also writes it. Lease expires in ${Math.max(0, peer.lease.leaseUntil - nowMs)}ms.`
        );
      }

      for (const resource of intersectResources(writeSet, peerReadSet)) {
        addConflict(
          peer,
          "read_write",
          resource,
          `Action "${action.type}" writes "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" reads it. Lease expires in ${Math.max(0, peer.lease.leaseUntil - nowMs)}ms.`
        );
      }

      for (const resource of intersectResources(readSet, peerWriteSet)) {
        addConflict(
          peer,
          "read_write",
          resource,
          `Action "${action.type}" reads "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" writes it. Lease expires in ${Math.max(0, peer.lease.leaseUntil - nowMs)}ms.`
        );
      }
    }

    return conflicts.sort((left, right) => {
      if (left.resource !== right.resource) {
        return left.resource.localeCompare(right.resource);
      }
      if (left.otherSessionId !== right.otherSessionId) {
        return left.otherSessionId.localeCompare(right.otherSessionId);
      }
      return actionKey(left.otherAction).localeCompare(actionKey(right.otherAction));
    });
  }

  private applyCrossSessionConflictGate(
    sessionId: string,
    sessionMetadata: SessionMetadata,
    context: EventContext | undefined,
    actionsApproved: Action[],
    arbitrationPolicyInput?: SessionArbitrationPolicyInput,
    nowMs: number = Date.now()
  ): {
    approvedActions: Action[];
    blockedActions: Action[];
    blockedWith: StepResult["blockedWith"];
    sessionArbitrationPolicy: SessionArbitrationPolicy;
    sessionConflicts: SessionConflictEvent[];
    sessionArbitrations: SessionArbitrationEvent[];
  } {
    const sessionArbitrationPolicy =
      this.resolveArbitrationPolicy(arbitrationPolicyInput);
    const scopedPeers = this.listScopedPeerActions(sessionId, context, nowMs);
    if (!sessionArbitrationPolicy.enabled) {
      return {
        approvedActions: deepClone(actionsApproved),
        blockedActions: [],
        blockedWith: [],
        sessionArbitrationPolicy,
        sessionConflicts: [],
        sessionArbitrations: [],
      };
    }

    if (scopedPeers.length === 0 || actionsApproved.length === 0) {
      return {
        approvedActions: deepClone(actionsApproved),
        blockedActions: [],
        blockedWith: [],
        sessionArbitrationPolicy,
        sessionConflicts: [],
        sessionArbitrations: [],
      };
    }

    const approvedActions: Action[] = [];
    const blockedActions: Action[] = [];
    const blockedWith: StepResult["blockedWith"] = [];
    const sessionConflicts: SessionConflictEvent[] = [];
    const sessionArbitrations: SessionArbitrationEvent[] = [];
    const peerMetadataBySessionId: Record<string, SessionMetadata> = {};
    for (const peer of scopedPeers) {
      peerMetadataBySessionId[peer.sessionId] = deepClone(peer.metadata);
    }

    for (const action of actionsApproved) {
      const conflicts = this.detectConflictsForAction(action, scopedPeers, nowMs);
      if (conflicts.length === 0) {
        approvedActions.push(action);
        continue;
      }

      const arbitrations = arbitrateSessionConflicts({
        sessionId,
        sessionMetadata,
        conflicts,
        peerMetadataBySessionId,
        policy: sessionArbitrationPolicy,
        conflictFreshnessMsByKey: Object.fromEntries(
          conflicts.map((conflict) => {
            const matchingPeer = scopedPeers.find(
              (peer) =>
                peer.sessionId === conflict.otherSessionId &&
                (normalizeResourceSet(peer.action.readSet).includes(conflict.resource) ||
                  normalizeResourceSet(peer.action.writeSet).includes(conflict.resource))
            );
            const freshnessMs = Math.max(
              0,
              (matchingPeer?.lease.leaseUntil ?? nowMs) - nowMs
            );
            return [sessionConflictKey(conflict), freshnessMs];
          })
        ),
      });
      const arbitrationByConflict = new Map(
        arbitrations.map((arbitration) => [
          sessionConflictKey(arbitration),
          arbitration,
        ])
      );
      const harmonizedConflicts = conflicts.map((conflict) => {
        const arbitration = arbitrationByConflict.get(sessionConflictKey(conflict));
        return arbitration
          ? { ...conflict, unblock: deepClone(arbitration.unblock) }
          : conflict;
      });

      blockedActions.push(action);
      sessionConflicts.push(...harmonizedConflicts);
      sessionArbitrations.push(...arbitrations);
      blockedWith.push({
        action,
        blockedBy: arbitrations.map(
          (arbitration) =>
            `session_arbitration:${arbitration.mode}:${arbitration.outcome}:${arbitration.resource}:${arbitration.otherSessionId}`
        ),
        enabledBy: [],
      });
    }

    return {
      approvedActions,
      blockedActions,
      blockedWith,
      sessionArbitrationPolicy,
      sessionConflicts,
      sessionArbitrations,
    };
  }

  stepSession(sessionId: string, request: StepSessionRequest): StepResult {
    const session = this.loadSession(sessionId);
    const nowMs = request.nowMs ?? Date.now();
    const pruned = pruneExpiredClaims(
      session.heldResourceClaims,
      session.heldResourceClaimLeases,
      nowMs
    );
    session.heldResourceClaims = pruned.claims;
    session.heldResourceClaimLeases = pruned.leases;

    const result = step({
      state: session.state,
      residual: session.residual,
      input: request.input ?? {},
      proposals: request.proposals ?? [],
      tensionTimeoutPolicy: request.tensionTimeoutPolicy,
      deadlockThreshold: request.deadlockThreshold,
      residualLimits: request.residualLimits,
      fingerprintHistory: session.fingerprintHistory,
      priorRevocable: session.activeRevocable,
      priorOperationFingerprints: session.operationFingerprints,
      nowMs,
    });

    if (
      request.context === undefined &&
      result.actionsApproved.some(isResourceAction)
    ) {
      throw new Error(
        `Session "${sessionId}" must provide branch or worktree context when proposing actions with readSet/writeSet.`
      );
    }

    const conflictContext = request.context;
    const conflictGate = this.applyCrossSessionConflictGate(
      sessionId,
      session.metadata,
      conflictContext,
      result.actionsApproved,
      request.arbitrationPolicy,
      nowMs
    );
    const approvedActionKeys = new Set(conflictGate.approvedActions.map(actionKey));
    const actionsApproved = conflictGate.approvedActions;
    const actionsBlocked = [...result.actionsBlocked, ...conflictGate.blockedActions];
    const approvedWith = result.approvedWith.filter((item) =>
      approvedActionKeys.has(actionKey(item.action))
    );
    const blockedWith = [...result.blockedWith, ...conflictGate.blockedWith];
    const sessionArbitrationPolicy = conflictGate.sessionArbitrationPolicy;
    const sessionConflicts = conflictGate.sessionConflicts;
    const sessionArbitrations = conflictGate.sessionArbitrations;
    const emittedRevocable = actionsApproved.filter((action) => action.revocable === true);

    const replay: ReplayEvent = {
      ...deepClone(result.replay),
      approvedActions: deepClone(actionsApproved),
      blockedActions: deepClone(actionsBlocked),
      ...(sessionConflicts.length > 0 || sessionArbitrations.length > 0
        ? {
            sessionEvents: {
              conflicts: deepClone(sessionConflicts),
              arbitrations: deepClone(sessionArbitrations),
            },
          }
        : {}),
      ...(request.context ? { context: deepClone(request.context) } : {}),
    };

    const nextClaimState = mergeClaimState({
      currentClaims: session.heldResourceClaims,
      currentLeases: session.heldResourceClaimLeases,
      approvedActions: actionsApproved,
      nowMs,
      leaseMs: this.claimLeaseMs,
    });
    const nextHeldResourceClaims = nextClaimState.claims;
    const nextHeldResourceClaimLeases = nextClaimState.leases;

    try {
      this.store.appendSessionEvent(
        sessionId,
        session.stepCount,
        replay,
        session.metadata,
        nextHeldResourceClaims,
        nextHeldResourceClaimLeases
      );
    } catch (error: unknown) {
      if (isSessionStepConflictError(error)) {
        this.sessions.delete(sessionId);
        throw new Error(
          `Concurrent session update detected for "${sessionId}". Reload state and retry the step.`
        );
      }
      throw error;
    }

    session.state = deepClone(result.stateNext);
    session.residual = deepClone(result.residualNext);
    session.stepCount += 1;
    session.fingerprintHistory = [...result.fingerprintHistory];
    session.heldResourceClaims = nextHeldResourceClaims;
    session.heldResourceClaimLeases = nextHeldResourceClaimLeases;
    if (request.context) {
      session.lastEventContext = deepClone(request.context);
    }
    session.lastReplayAttestation = replay.attestation
      ? deepClone(replay.attestation)
      : undefined;
    session.activeRevocable = reconcileRevocableActions(
      session.activeRevocable,
      actionsApproved,
      result.residualNext,
      result.stateNext
    );
    for (const action of actionsApproved) {
      const operationId = action.operationId?.trim();
      if (!operationId) continue;
      session.operationFingerprints[operationId] = actionOperationFingerprint(action);
    }

    return {
      ...result,
      actionsApproved,
      actionsBlocked,
      approvedWith,
      blockedWith,
      sessionArbitrationPolicy,
      sessionConflicts,
      sessionArbitrations,
      emittedRevocable,
      replay,
    };
  }

  updateSession(sessionId: string, request: UpdateSessionRequest): SessionSnapshot {
    const session = this.loadSession(sessionId);
    const metadata = applySessionMetadataPatch(session.metadata, request.metadata);
    const heldResourceClaims =
      request.releaseResourceClaims === true || metadata.status === "closed"
        ? []
        : deepClone(session.heldResourceClaims);
    const heldResourceClaimLeases =
      request.releaseResourceClaims === true || metadata.status === "closed"
        ? {}
        : deepClone(session.heldResourceClaimLeases);

    this.store.updateSession(
      sessionId,
      metadata,
      heldResourceClaims,
      heldResourceClaimLeases
    );
    session.metadata = deepClone(metadata);
    session.heldResourceClaims = deepClone(heldResourceClaims);
    session.heldResourceClaimLeases = deepClone(heldResourceClaimLeases);

    return this.getState(sessionId);
  }

  getState(sessionId: string): SessionSnapshot {
    const session = this.loadSession(sessionId);
    return {
      sessionId,
      state: deepClone(session.state),
      residual: deepClone(session.residual),
      stepCount: session.stepCount,
      metadata: deepClone(session.metadata),
      heldResourceClaims: deepClone(session.heldResourceClaims),
      lastEventContext: session.lastEventContext
        ? deepClone(session.lastEventContext)
        : undefined,
      lastReplayAttestation: session.lastReplayAttestation
        ? deepClone(session.lastReplayAttestation)
        : undefined,
    };
  }

  getReplayEvents(sessionId: string): SessionReplaySnapshot {
    this.loadSession(sessionId);
    return {
      sessionId,
      events: deepClone(this.store.readSessionEvents(sessionId)),
    };
  }

  listSessions(): SessionListItem[] {
    const persisted = this.store.listSessions();
    return persisted.map((item) => ({
      sessionId: item.sessionId,
      stepCount: item.stepCount,
      metadata: deepClone(item.metadata),
      heldResourceClaimCount: item.heldResourceClaimCount,
      lastEventContext: item.lastEventContext
        ? deepClone(item.lastEventContext)
        : undefined,
      lastReplayAttestation: item.lastReplayAttestation
        ? deepClone(item.lastReplayAttestation)
        : undefined,
    }));
  }

  importLegacyNdjsonSessions(): LegacyImportResult {
    const result = this.store.importLegacyNdjson(this.rootDir);
    this.sessions.clear();
    return result;
  }

  get rootPath(): string {
    return this.rootDir;
  }

  getLogPath(sessionId: string): string {
    this.loadSession(sessionId);
    return this.store.path;
  }

  getDatabasePath(): string {
    return this.store.path;
  }

  getJournalMode(): string {
    return this.store.getJournalMode();
  }
}
