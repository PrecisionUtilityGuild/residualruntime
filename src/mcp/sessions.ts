import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { step } from "../runtime/engine";
import { createFileLog } from "../runtime/fileAdapter";
import {
  createEmptyResidual,
  createInitialState,
  type Action,
  type EventContext,
  type Input,
  type Proposal,
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

export type SessionSnapshot = {
  sessionId: string;
  state: State;
  residual: Residual;
  stepCount: number;
  metadata: SessionMetadata;
  lastEventContext?: EventContext;
};

export type SessionListItem = {
  sessionId: string;
  stepCount: number;
  metadata: SessionMetadata;
  lastEventContext?: EventContext;
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
  lastApprovedActions: Action[];
  metadata: SessionMetadata;
  lastEventContext?: EventContext;
};

type PersistedSession = {
  sessionId: string;
  metadata: SessionMetadata;
  stepCount: number;
  lastEventContext?: EventContext;
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function actionKey(action: Action): string {
  return JSON.stringify({
    kind: action.kind,
    type: action.type,
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    revocable: action.revocable === true,
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
  });
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
  private readonly db: DatabaseSync;

  constructor(rootDir: string) {
    this.databasePath = join(rootDir, SESSION_DB_FILENAME);
    this.db = new DatabaseSync(this.databasePath);
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
      .run(sessionId, JSON.stringify(metadata), nowMs, nowMs);
  }

  getSessionMetadata(sessionId: string): SessionMetadata | undefined {
    const row = this.db
      .prepare("SELECT metadata_json FROM sessions WHERE session_id = ?")
      .get(sessionId) as { metadata_json: string } | undefined;

    if (!row) return undefined;

    try {
      return parseSessionMetadata(JSON.parse(row.metadata_json)) ?? normalizeSessionMetadata();
    } catch {
      return normalizeSessionMetadata();
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

  appendSessionEvent(sessionId: string, stepIndex: number, event: ReplayEvent): void {
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
        .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
        .run(nowMs, sessionId);

      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
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
      let metadata = normalizeSessionMetadata();
      try {
        metadata = parseSessionMetadata(JSON.parse(row.metadata_json)) ?? metadata;
      } catch {
        // Keep normalized fallback.
      }

      let lastEventContext: EventContext | undefined = undefined;
      if (row.last_event_json) {
        try {
          const event = JSON.parse(row.last_event_json) as ReplayEvent;
          lastEventContext = parseEventContext(event.context);
        } catch {
          lastEventContext = undefined;
        }
      }

      return {
        sessionId: row.session_id,
        metadata,
        stepCount: Number(row.step_count),
        lastEventContext,
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

  constructor(rootDir?: string) {
    this.rootDir = resolveSessionRootDir(rootDir);
    this.store = new SessionSqliteStore(this.rootDir);
    this.defaultArbitrationPolicy = resolveSessionArbitrationPolicy();
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

    const metadata = this.store.getSessionMetadata(sessionId) ?? normalizeSessionMetadata();
    const events = this.store.readSessionEvents(sessionId);

    let state = createInitialState();
    let residual = createEmptyResidual();
    let fingerprintHistory: string[] = [];
    let activeRevocable: Action[] = [];
    let lastApprovedActions: Action[] = [];
    let lastEventContext: EventContext | undefined = undefined;

    for (const event of events) {
      state = deepClone(event.after.state);
      residual = deepClone(event.after.residual);
      fingerprintHistory = [...fingerprintHistory, computeFingerprint(residual)];
      activeRevocable = reconcileRevocableActions(activeRevocable, event.approvedActions, residual, state);
      lastApprovedActions = deepClone(event.approvedActions);
      if (event.context) {
        lastEventContext = deepClone(event.context);
      }
    }

    const session: SessionRecord = {
      sessionId,
      state,
      residual,
      stepCount: events.length,
      fingerprintHistory,
      activeRevocable,
      lastApprovedActions,
      metadata,
      lastEventContext,
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
      lastApprovedActions: [],
      metadata,
      lastEventContext: undefined,
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
    context?: EventContext
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

      for (const action of loaded.lastApprovedActions) {
        const readSet = normalizeResourceSet(action.readSet);
        const writeSet = normalizeResourceSet(action.writeSet);
        if (readSet.length === 0 && writeSet.length === 0) continue;
        scoped.push({
          sessionId: loaded.sessionId,
          action: deepClone(action),
          scope: deepClone(scope),
          metadata: deepClone(loaded.metadata),
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
    scopedPeers: ScopedPeerAction[]
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
          `Action "${action.type}" writes "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" also writes it.`
        );
      }

      for (const resource of intersectResources(writeSet, peerReadSet)) {
        addConflict(
          peer,
          "read_write",
          resource,
          `Action "${action.type}" writes "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" reads it.`
        );
      }

      for (const resource of intersectResources(readSet, peerWriteSet)) {
        addConflict(
          peer,
          "read_write",
          resource,
          `Action "${action.type}" reads "${resource}" while session "${peer.sessionId}" action "${peer.action.type}" writes it.`
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
    arbitrationPolicyInput?: SessionArbitrationPolicyInput
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
    const scopedPeers = this.listScopedPeerActions(sessionId, context);
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
      const conflicts = this.detectConflictsForAction(action, scopedPeers);
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
      nowMs: request.nowMs,
    });

    const conflictContext = request.context ?? session.lastEventContext;
    const conflictGate = this.applyCrossSessionConflictGate(
      sessionId,
      session.metadata,
      conflictContext,
      result.actionsApproved,
      request.arbitrationPolicy
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

    try {
      this.store.appendSessionEvent(sessionId, session.stepCount, replay);
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
    session.lastApprovedActions = deepClone(actionsApproved);
    if (request.context) {
      session.lastEventContext = deepClone(request.context);
    }
    session.activeRevocable = reconcileRevocableActions(
      session.activeRevocable,
      actionsApproved,
      result.residualNext,
      result.stateNext
    );

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

  getState(sessionId: string): SessionSnapshot {
    const session = this.loadSession(sessionId);
    return {
      sessionId,
      state: deepClone(session.state),
      residual: deepClone(session.residual),
      stepCount: session.stepCount,
      metadata: deepClone(session.metadata),
      lastEventContext: session.lastEventContext
        ? deepClone(session.lastEventContext)
        : undefined,
    };
  }

  listSessions(): SessionListItem[] {
    const persisted = this.store.listSessions();
    return persisted.map((item) => ({
      sessionId: item.sessionId,
      stepCount: item.stepCount,
      metadata: deepClone(item.metadata),
      lastEventContext: item.lastEventContext
        ? deepClone(item.lastEventContext)
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
