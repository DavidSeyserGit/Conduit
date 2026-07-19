use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::State;

const DATABASE_VERSION: i64 = 3;
const ORPHAN_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);

const MIGRATION_1: &str = r#"
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE goal_versions (
  goal_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (goal_id, version),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

CREATE TABLE goal_questions (
  goal_id TEXT NOT NULL,
  goal_version INTEGER NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (goal_id, goal_version, id),
  FOREIGN KEY (goal_id, goal_version) REFERENCES goal_versions(goal_id, version) ON DELETE CASCADE
);

CREATE TABLE goal_answers (
  goal_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (goal_id, question_id, answered_at),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

CREATE TABLE goal_runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  active_goal_version INTEGER,
  workflow_phase TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  legacy INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE TABLE review_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  data_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (review_id) REFERENCES review_results(id) ON DELETE CASCADE
);

CREATE TABLE evidence_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  required INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  artifact_id TEXT,
  data_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  final_status TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE
);

CREATE INDEX goal_runs_phase_idx ON goal_runs(workflow_phase, updated_at DESC);
CREATE INDEX run_events_run_idx ON run_events(run_id, sequence);
CREATE INDEX review_results_run_idx ON review_results(run_id, reviewed_at);
CREATE INDEX evidence_items_run_idx ON evidence_items(run_id, collected_at);
"#;

const MIGRATION_2: &str = r#"
CREATE TABLE review_findings_v2 (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  data_json TEXT NOT NULL,
  PRIMARY KEY (review_id, id),
  FOREIGN KEY (run_id) REFERENCES goal_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (review_id) REFERENCES review_results(id) ON DELETE CASCADE
);

INSERT INTO review_findings_v2(id, run_id, review_id, severity, file_path, data_json)
SELECT id, run_id, review_id, severity, file_path, data_json FROM review_findings;

DROP TABLE review_findings;
ALTER TABLE review_findings_v2 RENAME TO review_findings;
CREATE INDEX review_findings_run_idx ON review_findings(run_id, review_id);
"#;

const MIGRATION_3: &str = r#"
CREATE TABLE cgs_artifacts (
  id TEXT PRIMARY KEY,
  cgs_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  data_json TEXT NOT NULL
);
CREATE INDEX cgs_artifacts_kind_idx ON cgs_artifacts(kind, created_at DESC);
"#;

const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_1), (2, MIGRATION_2), (3, MIGRATION_3)];

#[derive(Default)]
pub struct GoalPersistenceState {
    inner: Mutex<StorageAvailability>,
}

#[derive(Default)]
enum StorageAvailability {
    #[default]
    Uninitialized,
    Ready(GoalRepository),
    Failed(String),
}

impl GoalPersistenceState {
    pub fn initialize(&self, app_data_dir: PathBuf) {
        let next = match GoalRepository::open(&app_data_dir) {
            Ok(repository) => StorageAvailability::Ready(repository),
            Err(error) => StorageAvailability::Failed(error),
        };
        if let Ok(mut inner) = self.inner.lock() {
            *inner = next;
        }
    }

    fn with_repository<T>(
        &self,
        operation: impl FnOnce(&GoalRepository) -> Result<T, String>,
    ) -> Result<T, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Goal storage lock is poisoned".to_string())?;
        match &*inner {
            StorageAvailability::Ready(repository) => operation(repository),
            StorageAvailability::Failed(error) => {
                Err(format!("Goal storage is unavailable: {error}"))
            }
            StorageAvailability::Uninitialized => {
                Err("Goal storage has not been initialized".to_string())
            }
        }
    }

    fn status(&self) -> StorageStatus {
        match self.inner.lock() {
            Ok(inner) => match &*inner {
                StorageAvailability::Ready(repository) => StorageStatus {
                    available: true,
                    schema_version: Some(DATABASE_VERSION),
                    database_path: Some(repository.database_path.to_string_lossy().to_string()),
                    artifact_root: Some(repository.artifact_root.to_string_lossy().to_string()),
                    error: None,
                },
                StorageAvailability::Failed(error) => StorageStatus {
                    available: false,
                    schema_version: None,
                    database_path: None,
                    artifact_root: None,
                    error: Some(error.clone()),
                },
                StorageAvailability::Uninitialized => StorageStatus {
                    available: false,
                    schema_version: None,
                    database_path: None,
                    artifact_root: None,
                    error: Some("Goal storage has not been initialized".to_string()),
                },
            },
            Err(_) => StorageStatus {
                available: false,
                schema_version: None,
                database_path: None,
                artifact_root: None,
                error: Some("Goal storage lock is poisoned".to_string()),
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    available: bool,
    schema_version: Option<i64>,
    database_path: Option<String>,
    artifact_root: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum StorageWrite {
    UpsertCgsArtifact {
        artifact: Value,
    },
    UpsertGoal {
        goal: Value,
    },
    InsertGoalVersion {
        version: Value,
    },
    ReplaceQuestions {
        goal_id: String,
        goal_version: i64,
        questions: Vec<Value>,
    },
    UpsertAnswer {
        goal_id: String,
        answer: Value,
    },
    UpsertRun {
        run: Value,
    },
    AppendEvent {
        event: Value,
    },
    UpsertReview {
        run_id: String,
        review: Value,
    },
    UpsertEvidenceRequest {
        run_id: String,
        request: Value,
    },
    UpsertEvidenceItem {
        run_id: String,
        evidence: Value,
    },
    UpsertReport {
        report: Value,
    },
    DeleteRun {
        run_id: String,
    },
    DeleteGoal {
        goal_id: String,
    },
    ImportLegacyRun {
        run: Value,
        events: Vec<Value>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum StorageRead {
    CgsArtifact { id: String },
    Goal { id: String },
    RunSnapshot { run_id: String },
    Runs { phases: Option<Vec<String>> },
    ArtifactMetadata { artifact_id: String },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    id: String,
    run_id: String,
    relative_path: String,
    sha256: String,
    size: i64,
    content_type: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    metadata: ArtifactMetadata,
    content: String,
}

#[derive(Debug)]
struct GoalRepository {
    database_path: PathBuf,
    artifact_root: PathBuf,
}

impl GoalRepository {
    fn open(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("Could not create app data directory: {error}"))?;
        let artifact_root = app_data_dir.join("goal-artifacts");
        fs::create_dir_all(&artifact_root)
            .map_err(|error| format!("Could not create artifact directory: {error}"))?;
        let repository = Self {
            database_path: app_data_dir.join("goals.sqlite3"),
            artifact_root,
        };
        repository.migrate()?;
        repository.cleanup_orphan_artifacts(ORPHAN_GRACE_PERIOD)?;
        Ok(repository)
    }

    fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.database_path).map_err(storage_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .map_err(storage_error)?;
        Ok(connection)
    }

    fn migrate(&self) -> Result<(), String> {
        let mut connection = self.connection()?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(storage_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage_error)?;
        if version > DATABASE_VERSION {
            return Err(format!("Goal database version {version} is newer than supported version {DATABASE_VERSION}"));
        }
        for (target_version, sql) in MIGRATIONS.iter().filter(|(target, _)| version < *target) {
            let transaction = connection.transaction().map_err(storage_error)?;
            transaction.execute_batch(sql).map_err(storage_error)?;
            transaction
                .pragma_update(None, "user_version", *target_version)
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
        }
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(storage_error)?;
        if integrity != "ok" {
            return Err(format!("Goal database integrity check failed: {integrity}"));
        }
        Ok(())
    }

    fn write(&self, operation: StorageWrite) -> Result<Value, String> {
        match operation {
            StorageWrite::UpsertCgsArtifact { artifact } => self.upsert_cgs_artifact(&artifact),
            StorageWrite::UpsertGoal { goal } => self.upsert_goal(&goal),
            StorageWrite::InsertGoalVersion { version } => self.insert_goal_version(&version),
            StorageWrite::ReplaceQuestions {
                goal_id,
                goal_version,
                questions,
            } => self.replace_questions(&goal_id, goal_version, &questions),
            StorageWrite::UpsertAnswer { goal_id, answer } => self.upsert_answer(&goal_id, &answer),
            StorageWrite::UpsertRun { run } => self.upsert_run(&run, false),
            StorageWrite::AppendEvent { event } => self.append_event(&event),
            StorageWrite::UpsertReview { run_id, review } => self.upsert_review(&run_id, &review),
            StorageWrite::UpsertEvidenceRequest { run_id, request } => {
                self.upsert_evidence_request(&run_id, &request)
            }
            StorageWrite::UpsertEvidenceItem { run_id, evidence } => {
                self.upsert_evidence_item(&run_id, &evidence)
            }
            StorageWrite::UpsertReport { report } => self.upsert_report(&report),
            StorageWrite::DeleteRun { run_id } => self.delete_run(&run_id),
            StorageWrite::DeleteGoal { goal_id } => self.delete_goal(&goal_id),
            StorageWrite::ImportLegacyRun { run, events } => self.import_legacy_run(&run, &events),
        }
    }

    fn read(&self, query: StorageRead) -> Result<Value, String> {
        match query {
            StorageRead::CgsArtifact { id } => Ok(self
                .read_json_optional("SELECT data_json FROM cgs_artifacts WHERE id = ?1", &id)?
                .unwrap_or(Value::Null)),
            StorageRead::Goal { id } => Ok(self
                .read_json_optional("SELECT data_json FROM goals WHERE id = ?1", &id)?
                .unwrap_or(Value::Null)),
            StorageRead::RunSnapshot { run_id } => self.run_snapshot(&run_id),
            StorageRead::Runs { phases } => self.list_runs(phases.as_deref()),
            StorageRead::ArtifactMetadata { artifact_id } => {
                Ok(serde_json::to_value(self.artifact_metadata(&artifact_id)?)
                    .map_err(json_error)?)
            }
        }
    }

    fn upsert_goal(&self, goal: &Value) -> Result<Value, String> {
        let id = required_string(goal, "id")?;
        let version = required_i64(goal, "version")?;
        let status = required_string(goal, "status")?;
        let created_at = required_string(goal, "createdAt")?;
        let updated_at = required_string(goal, "updatedAt")?;
        let data = serde_json::to_string(goal).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO goals(id, current_version, status, created_at, updated_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version, status=excluded.status, updated_at=excluded.updated_at, data_json=excluded.data_json",
            params![id, version, status, created_at, updated_at, data],
        ).map_err(storage_error)?;
        Ok(json!({ "id": id }))
    }

    fn upsert_cgs_artifact(&self, artifact: &Value) -> Result<Value, String> {
        let id = required_string(artifact, "id")?;
        let cgs_version = required_string(artifact, "cgsVersion")?;
        let kind = required_string(artifact, "kind")?;
        let created_at = required_string(artifact, "createdAt")?;
        let updated_at = optional_string(artifact, "updatedAt");
        let data = serde_json::to_string(artifact).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO cgs_artifacts(id, cgs_version, kind, created_at, updated_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET cgs_version=excluded.cgs_version, kind=excluded.kind, updated_at=excluded.updated_at, data_json=excluded.data_json",
            params![id, cgs_version, kind, created_at, updated_at, data],
        ).map_err(storage_error)?;
        Ok(json!({ "id": id, "kind": kind, "cgsVersion": cgs_version }))
    }

    fn insert_goal_version(&self, version: &Value) -> Result<Value, String> {
        let goal_id = required_string(version, "goalId")?;
        let number = required_i64(version, "version")?;
        let created_at = required_string(version, "createdAt")?;
        let created_by = required_string(version, "createdBy")?;
        let data = serde_json::to_string(version).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO goal_versions(goal_id, version, created_at, created_by, data_json) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(goal_id, version) DO UPDATE SET created_at=excluded.created_at, created_by=excluded.created_by, data_json=excluded.data_json",
            params![goal_id, number, created_at, created_by, data],
        ).map_err(storage_error)?;
        Ok(json!({ "goalId": goal_id, "version": number }))
    }

    fn replace_questions(
        &self,
        goal_id: &str,
        goal_version: i64,
        questions: &[Value],
    ) -> Result<Value, String> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM goal_questions WHERE goal_id = ?1 AND goal_version = ?2",
                params![goal_id, goal_version],
            )
            .map_err(storage_error)?;
        for (position, question) in questions.iter().enumerate() {
            let id = required_string(question, "id")?;
            let data = serde_json::to_string(question).map_err(json_error)?;
            transaction.execute(
                "INSERT INTO goal_questions(goal_id, goal_version, id, position, data_json) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![goal_id, goal_version, id, position as i64, data],
            ).map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(json!({ "count": questions.len() }))
    }

    fn upsert_answer(&self, goal_id: &str, answer: &Value) -> Result<Value, String> {
        let question_id = required_string(answer, "questionId")?;
        let answered_at = required_string(answer, "answeredAt")?;
        let data = serde_json::to_string(answer).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO goal_answers(goal_id, question_id, answered_at, data_json) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(goal_id, question_id, answered_at) DO UPDATE SET data_json=excluded.data_json",
            params![goal_id, question_id, answered_at, data],
        ).map_err(storage_error)?;
        Ok(json!({ "goalId": goal_id, "questionId": question_id }))
    }

    fn upsert_run(&self, run: &Value, legacy: bool) -> Result<Value, String> {
        upsert_run_on(&self.connection()?, run, legacy)
    }

    fn append_event(&self, event: &Value) -> Result<Value, String> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let result = append_event_on(&transaction, event)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }

    fn upsert_review(&self, run_id: &str, review: &Value) -> Result<Value, String> {
        let id = required_string(review, "id")?;
        let reviewer_id = required_string(review, "reviewerId")?;
        let status = required_string(review, "status")?;
        let reviewed_at = required_string(review, "reviewedAt")?;
        let data = serde_json::to_string(review).map_err(json_error)?;
        let findings = review
            .get("findings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction.execute(
            "INSERT INTO review_results(id, run_id, reviewer_id, status, reviewed_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, reviewed_at=excluded.reviewed_at, data_json=excluded.data_json",
            params![id, run_id, reviewer_id, status, reviewed_at, data],
        ).map_err(storage_error)?;
        transaction
            .execute("DELETE FROM review_findings WHERE review_id = ?1", [id])
            .map_err(storage_error)?;
        for finding in &findings {
            insert_finding(&transaction, run_id, id, finding)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(json!({ "id": id, "findingCount": findings.len() }))
    }

    fn upsert_evidence_request(&self, run_id: &str, request: &Value) -> Result<Value, String> {
        let id = required_string(request, "id")?;
        let reviewer_id = required_string(request, "reviewerId")?;
        let status = required_string(request, "status")?;
        let required = request
            .get("required")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Missing required boolean field required".to_string())?;
        let requested_at = required_string(request, "requestedAt")?;
        let data = serde_json::to_string(request).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO evidence_requests(id, run_id, reviewer_id, status, required, requested_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, required=excluded.required, data_json=excluded.data_json",
            params![id, run_id, reviewer_id, status, required as i64, requested_at, data],
        ).map_err(storage_error)?;
        Ok(json!({ "id": id }))
    }

    fn upsert_evidence_item(&self, run_id: &str, evidence: &Value) -> Result<Value, String> {
        let id = required_string(evidence, "id")?;
        let evidence_type = required_string(evidence, "type")?;
        let freshness_status = evidence
            .pointer("/freshness/status")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing freshness.status".to_string())?;
        let collected_at = required_string(evidence, "collectedAt")?;
        let artifact_id = optional_string(evidence, "artifactId");
        let data = serde_json::to_string(evidence).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO evidence_items(id, run_id, evidence_type, freshness_status, collected_at, artifact_id, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET freshness_status=excluded.freshness_status, artifact_id=excluded.artifact_id, data_json=excluded.data_json",
            params![id, run_id, evidence_type, freshness_status, collected_at, artifact_id, data],
        ).map_err(storage_error)?;
        Ok(json!({ "id": id }))
    }

    fn upsert_report(&self, report: &Value) -> Result<Value, String> {
        let id = required_string(report, "id")?;
        let run_id = required_string(report, "runId")?;
        let final_status = report
            .pointer("/overview/finalStatus")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing overview.finalStatus".to_string())?;
        let generated_at = required_string(report, "generatedAt")?;
        let data = serde_json::to_string(report).map_err(json_error)?;
        self.connection()?.execute(
            "INSERT INTO reports(id, run_id, final_status, generated_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(run_id) DO UPDATE SET id=excluded.id, final_status=excluded.final_status, generated_at=excluded.generated_at, data_json=excluded.data_json",
            params![id, run_id, final_status, generated_at, data],
        ).map_err(storage_error)?;
        Ok(json!({ "id": id }))
    }

    fn delete_run(&self, run_id: &str) -> Result<Value, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT relative_path FROM artifacts WHERE run_id = ?1")
            .map_err(storage_error)?;
        let artifact_paths = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let deleted = connection
            .execute("DELETE FROM goal_runs WHERE id = ?1", [run_id])
            .map_err(storage_error)?;
        for relative_path in artifact_paths {
            if let Ok(path) = self.safe_artifact_path(&relative_path) {
                let _ = fs::remove_file(path);
            }
        }
        Ok(json!({ "deleted": deleted > 0 }))
    }

    fn delete_goal(&self, goal_id: &str) -> Result<Value, String> {
        let deleted = self
            .connection()?
            .execute("DELETE FROM goals WHERE id = ?1", [goal_id])
            .map_err(storage_error)?;
        Ok(json!({ "deleted": deleted > 0 }))
    }

    fn import_legacy_run(&self, run: &Value, events: &[Value]) -> Result<Value, String> {
        let run_id = required_string(run, "id")?.to_string();
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        upsert_run_on(&transaction, run, true)?;
        for (index, event) in events.iter().enumerate() {
            let normalized = normalize_legacy_event(&run_id, index, event)?;
            let id = required_string(&normalized, "id")?;
            if !event_exists_on(&transaction, id)? {
                append_event_on(&transaction, &normalized)?;
            }
        }
        transaction.commit().map_err(storage_error)?;
        Ok(json!({ "id": run_id, "importedEvents": events.len() }))
    }

    fn run_snapshot(&self, run_id: &str) -> Result<Value, String> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let run = read_json_optional_on(
            &transaction,
            "SELECT data_json FROM goal_runs WHERE id = ?1",
            run_id,
        )?;
        let Some(run) = run else {
            return Ok(Value::Null);
        };
        let goal_id = transaction
            .query_row(
                "SELECT goal_id FROM goal_runs WHERE id = ?1",
                [run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(storage_error)?;
        let goal = match goal_id.as_deref() {
            Some(id) => read_json_optional_on(
                &transaction,
                "SELECT data_json FROM goals WHERE id = ?1",
                id,
            )?,
            None => None,
        };
        let versions = match goal_id.as_deref() {
            Some(id) => read_json_list_on(
                &transaction,
                "SELECT data_json FROM goal_versions WHERE goal_id = ?1 ORDER BY version",
                id,
            )?,
            None => vec![],
        };
        let questions = match goal_id.as_deref() {
            Some(id) => read_json_list_on(&transaction, "SELECT data_json FROM goal_questions WHERE goal_id = ?1 ORDER BY goal_version, position", id)?,
            None => vec![],
        };
        let answers = match goal_id.as_deref() {
            Some(id) => read_json_list_on(
                &transaction,
                "SELECT data_json FROM goal_answers WHERE goal_id = ?1 ORDER BY answered_at",
                id,
            )?,
            None => vec![],
        };
        Ok(json!({
            "run": run,
            "goal": goal,
            "versions": versions,
            "questions": questions,
            "answers": answers,
            "events": read_json_list_on(&transaction, "SELECT data_json FROM run_events WHERE run_id = ?1 ORDER BY sequence", run_id)?,
            "reviews": read_json_list_on(&transaction, "SELECT data_json FROM review_results WHERE run_id = ?1 ORDER BY reviewed_at", run_id)?,
            "findings": read_json_list_on(&transaction, "SELECT data_json FROM review_findings WHERE run_id = ?1 ORDER BY rowid", run_id)?,
            "evidenceRequests": read_json_list_on(&transaction, "SELECT data_json FROM evidence_requests WHERE run_id = ?1 ORDER BY requested_at", run_id)?,
            "evidence": read_json_list_on(&transaction, "SELECT data_json FROM evidence_items WHERE run_id = ?1 ORDER BY collected_at", run_id)?,
            "report": read_json_optional_on(&transaction, "SELECT data_json FROM reports WHERE run_id = ?1", run_id)?,
        }))
    }

    fn list_runs(&self, phases: Option<&[String]>) -> Result<Value, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT workflow_phase, data_json FROM goal_runs ORDER BY updated_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;
        let allowed = phases.map(|items| items.iter().map(String::as_str).collect::<HashSet<_>>());
        let mut runs = Vec::new();
        for row in rows {
            let (phase, data) = row.map_err(storage_error)?;
            if allowed
                .as_ref()
                .is_some_and(|items| !items.contains(phase.as_str()))
            {
                continue;
            }
            runs.push(serde_json::from_str::<Value>(&data).map_err(json_error)?);
        }
        Ok(Value::Array(runs))
    }

    fn read_json_optional(&self, sql: &str, id: &str) -> Result<Option<Value>, String> {
        let data = self
            .connection()?
            .query_row(sql, [id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(storage_error)?;
        data.map(|value| serde_json::from_str(&value).map_err(json_error))
            .transpose()
    }

    fn write_artifact(
        &self,
        run_id: &str,
        content: &str,
        content_type: &str,
    ) -> Result<ArtifactMetadata, String> {
        if !self.run_exists(run_id)? {
            return Err(format!("Cannot attach an artifact to unknown run {run_id}"));
        }
        let content_hash = sha256(content.as_bytes());
        let created_at = chrono::Utc::now().to_rfc3339();
        let id =
            sha256(format!("{run_id}:{created_at}:{content_hash}").as_bytes())[..32].to_string();
        let run_directory = self.artifact_root.join("runs").join(safe_segment(run_id));
        fs::create_dir_all(&run_directory)
            .map_err(|error| format!("Could not create run artifact directory: {error}"))?;
        let file_name = format!("{id}.artifact");
        let path = run_directory.join(&file_name);
        let mut temporary = tempfile::NamedTempFile::new_in(&run_directory)
            .map_err(|error| format!("Could not create temporary artifact: {error}"))?;
        std::io::Write::write_all(&mut temporary, content.as_bytes())
            .map_err(|error| format!("Could not write artifact: {error}"))?;
        temporary
            .persist(&path)
            .map_err(|error| format!("Could not persist artifact: {}", error.error))?;
        let relative_path = path
            .strip_prefix(&self.artifact_root)
            .map_err(|_| "Artifact path escaped its root".to_string())?
            .to_string_lossy()
            .to_string();
        let metadata = ArtifactMetadata {
            id: id.clone(),
            run_id: run_id.to_string(),
            relative_path,
            sha256: content_hash,
            size: content.len() as i64,
            content_type: content_type.to_string(),
            created_at,
        };
        self.connection()?.execute(
            "INSERT INTO artifacts(id, run_id, relative_path, sha256, size, content_type, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![metadata.id, metadata.run_id, metadata.relative_path, metadata.sha256, metadata.size, metadata.content_type, metadata.created_at],
        ).map_err(storage_error)?;
        Ok(metadata)
    }

    fn read_artifact(&self, artifact_id: &str) -> Result<ArtifactContent, String> {
        let metadata = self.artifact_metadata(artifact_id)?;
        let path = self.safe_artifact_path(&metadata.relative_path)?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("Could not read artifact {artifact_id}: {error}"))?;
        if sha256(&bytes) != metadata.sha256 {
            return Err(format!("Artifact {artifact_id} failed its integrity check"));
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| format!("Artifact {artifact_id} is not UTF-8 text"))?;
        Ok(ArtifactContent { metadata, content })
    }

    fn artifact_metadata(&self, artifact_id: &str) -> Result<ArtifactMetadata, String> {
        self.connection()?.query_row(
            "SELECT id, run_id, relative_path, sha256, size, content_type, created_at FROM artifacts WHERE id = ?1",
            [artifact_id],
            |row| Ok(ArtifactMetadata {
                id: row.get(0)?,
                run_id: row.get(1)?,
                relative_path: row.get(2)?,
                sha256: row.get(3)?,
                size: row.get(4)?,
                content_type: row.get(5)?,
                created_at: row.get(6)?,
            }),
        ).optional().map_err(storage_error)?.ok_or_else(|| format!("Unknown artifact {artifact_id}"))
    }

    fn safe_artifact_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Artifact path is outside the managed artifact directory".to_string());
        }
        let path = self.artifact_root.join(relative);
        let canonical_root = self
            .artifact_root
            .canonicalize()
            .map_err(|error| format!("Could not resolve artifact root: {error}"))?;
        let canonical_path = path
            .canonicalize()
            .map_err(|error| format!("Could not resolve artifact path: {error}"))?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("Artifact path is outside the managed artifact directory".to_string());
        }
        Ok(canonical_path)
    }

    fn cleanup_orphan_artifacts(&self, minimum_age: Duration) -> Result<usize, String> {
        let known = self.known_artifact_paths()?;
        let mut files = Vec::new();
        collect_files(&self.artifact_root, &mut files)?;
        let now = SystemTime::now();
        let mut removed = 0;
        for path in files {
            let relative = path
                .strip_prefix(&self.artifact_root)
                .map_err(|_| "Artifact path escaped its root".to_string())?
                .to_string_lossy()
                .to_string();
            if known.contains(&relative) {
                continue;
            }
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .map_err(|error| format!("Could not inspect orphan artifact: {error}"))?;
            if now.duration_since(modified).unwrap_or_default() >= minimum_age {
                fs::remove_file(&path)
                    .map_err(|error| format!("Could not remove orphan artifact: {error}"))?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn known_artifact_paths(&self) -> Result<HashSet<String>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT relative_path FROM artifacts")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)).collect()
    }

    fn run_exists(&self, run_id: &str) -> Result<bool, String> {
        self.connection()?
            .query_row(
                "SELECT 1 FROM goal_runs WHERE id = ?1",
                [run_id],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(storage_error)
    }
}

fn upsert_run_on(connection: &Connection, run: &Value, legacy: bool) -> Result<Value, String> {
    let id = required_string(run, "id")?;
    let goal_id = optional_string(run, "goalId");
    let active_goal_version = optional_i64(run, "activeGoalVersion");
    let workflow_phase = if legacy {
        legacy_phase(required_string(run, "status")?)
    } else {
        required_string(run, "workflowPhase")?.to_string()
    };
    let workspace_path = required_string(run, "workspacePath")?;
    let started_at = required_string(run, "startedAt")?;
    let updated_at = optional_string(run, "updatedAt").unwrap_or(started_at);
    let finished_at = optional_string(run, "finishedAt");
    let data = serde_json::to_string(run).map_err(json_error)?;
    connection.execute(
        "INSERT INTO goal_runs(id, goal_id, active_goal_version, workflow_phase, workspace_path, started_at, updated_at, finished_at, legacy, data_json)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET goal_id=excluded.goal_id, active_goal_version=excluded.active_goal_version, workflow_phase=excluded.workflow_phase, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at, finished_at=excluded.finished_at, legacy=excluded.legacy, data_json=excluded.data_json",
        params![id, goal_id, active_goal_version, workflow_phase, workspace_path, started_at, updated_at, finished_at, legacy as i64, data],
    ).map_err(storage_error)?;
    Ok(json!({ "id": id }))
}

fn append_event_on(connection: &Connection, event: &Value) -> Result<Value, String> {
    let id = required_string(event, "id")?;
    let run_id = required_string(event, "runId")?;
    let event_type = required_string(event, "type")?;
    let occurred_at = required_string(event, "occurredAt")?;
    let data = serde_json::to_string(event).map_err(json_error)?;
    let sequence: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_events WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    connection.execute(
        "INSERT INTO run_events(id, run_id, sequence, event_type, occurred_at, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, run_id, sequence, event_type, occurred_at, data],
    ).map_err(storage_error)?;
    Ok(json!({ "id": id, "sequence": sequence }))
}

fn event_exists_on(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row("SELECT 1 FROM run_events WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|value| value.is_some())
        .map_err(storage_error)
}

fn insert_finding(
    transaction: &Transaction<'_>,
    run_id: &str,
    review_id: &str,
    finding: &Value,
) -> Result<(), String> {
    let id = required_string(finding, "id")?;
    let severity = required_string(finding, "severity")?;
    let file_path = optional_string(finding, "filePath");
    let data = serde_json::to_string(finding).map_err(json_error)?;
    transaction.execute(
        "INSERT INTO review_findings(id, run_id, review_id, severity, file_path, data_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, run_id, review_id, severity, file_path, data],
    ).map_err(storage_error)?;
    Ok(())
}

fn normalize_legacy_event(run_id: &str, index: usize, event: &Value) -> Result<Value, String> {
    let mut normalized = event.clone();
    let object = normalized
        .as_object_mut()
        .ok_or_else(|| "Legacy event must be an object".to_string())?;
    let event_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("legacy_event")
        .to_string();
    object
        .entry("id")
        .or_insert_with(|| Value::String(format!("legacy:{run_id}:{index}")));
    object
        .entry("runId")
        .or_insert_with(|| Value::String(run_id.to_string()));
    object
        .entry("occurredAt")
        .or_insert_with(|| Value::String(chrono::Utc::now().to_rfc3339()));
    object
        .entry("type")
        .or_insert_with(|| Value::String(event_type));
    Ok(normalized)
}

fn legacy_phase(status: &str) -> String {
    match status {
        "completed" => "completed",
        "cancelled" => "cancelled",
        "failed" | "iteration_limit_reached" => "failed",
        _ => "implementing",
    }
    .to_string()
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| format!("Missing required string field {key}"))
}

fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn required_i64(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Missing required integer field {key}"))
}

fn optional_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn storage_error(error: rusqlite::Error) -> String {
    format!("Goal storage error: {error}")
}

fn json_error(error: serde_json::Error) -> String {
    format!("Invalid stored JSON: {error}")
}

fn read_json_optional_on(
    connection: &Connection,
    sql: &str,
    id: &str,
) -> Result<Option<Value>, String> {
    let data = connection
        .query_row(sql, [id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(storage_error)?;
    data.map(|value| serde_json::from_str(&value).map_err(json_error))
        .transpose()
}

fn read_json_list_on(connection: &Connection, sql: &str, id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let rows = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    rows.map(|row| {
        row.map_err(storage_error)
            .and_then(|data| serde_json::from_str(&data).map_err(json_error))
    })
    .collect()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .take(80)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect artifact directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect artifact entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect artifact entry type: {error}"))?;
        let path = entry.path();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&path, files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn goal_storage_status(state: State<'_, GoalPersistenceState>) -> StorageStatus {
    state.status()
}

#[tauri::command]
pub fn goal_storage_write(
    operation: StorageWrite,
    state: State<'_, GoalPersistenceState>,
) -> Result<Value, String> {
    state.with_repository(|repository| repository.write(operation))
}

#[tauri::command]
pub fn goal_storage_read(
    query: StorageRead,
    state: State<'_, GoalPersistenceState>,
) -> Result<Value, String> {
    state.with_repository(|repository| repository.read(query))
}

#[tauri::command]
pub fn goal_artifact_write(
    run_id: String,
    content: String,
    content_type: String,
    state: State<'_, GoalPersistenceState>,
) -> Result<ArtifactMetadata, String> {
    state.with_repository(|repository| repository.write_artifact(&run_id, &content, &content_type))
}

#[tauri::command]
pub fn goal_artifact_read(
    artifact_id: String,
    state: State<'_, GoalPersistenceState>,
) -> Result<ArtifactContent, String> {
    state.with_repository(|repository| repository.read_artifact(&artifact_id))
}

#[tauri::command]
pub fn goal_artifact_cleanup(
    older_than_seconds: Option<u64>,
    state: State<'_, GoalPersistenceState>,
) -> Result<usize, String> {
    let minimum_age =
        Duration::from_secs(older_than_seconds.unwrap_or(ORPHAN_GRACE_PERIOD.as_secs()));
    state.with_repository(|repository| repository.cleanup_orphan_artifacts(minimum_age))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> (tempfile::TempDir, GoalRepository) {
        let directory = tempfile::tempdir().unwrap();
        let repository = GoalRepository::open(directory.path()).unwrap();
        (directory, repository)
    }

    fn goal() -> Value {
        json!({
            "schemaVersion": 1,
            "id": "goal-1",
            "version": 1,
            "status": "approved",
            "createdAt": "2026-07-18T08:00:00Z",
            "updatedAt": "2026-07-18T08:01:00Z"
        })
    }

    fn version() -> Value {
        json!({
            "goalId": "goal-1",
            "version": 1,
            "createdAt": "2026-07-18T08:01:00Z",
            "createdBy": "user",
            "definition": goal()
        })
    }

    fn run() -> Value {
        json!({
            "formatVersion": 1,
            "id": "run-1",
            "goalId": "goal-1",
            "activeGoalVersion": 1,
            "workflowPhase": "awaiting_user_input",
            "workspacePath": "/tmp/repository",
            "startedAt": "2026-07-18T08:00:00Z",
            "updatedAt": "2026-07-18T08:01:00Z"
        })
    }

    #[test]
    fn creates_and_reopens_the_current_database_schema() {
        let (directory, repository) = repository();
        let connection = repository.connection().unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);
        drop(connection);
        GoalRepository::open(directory.path()).unwrap();
    }

    #[test]
    fn stores_cgs_artifacts_losslessly_by_portable_id() {
        let (_directory, repository) = repository();
        let artifact = json!({
            "cgsVersion": "0.1.0",
            "kind": "goal",
            "id": "goal-cgs-1",
            "createdAt": "2026-07-19T10:00:00Z",
            "title": "Portable goal",
            "extensionField": { "retained": true }
        });
        repository
            .write(StorageWrite::UpsertCgsArtifact {
                artifact: artifact.clone(),
            })
            .unwrap();
        let stored = repository
            .read(StorageRead::CgsArtifact {
                id: "goal-cgs-1".into(),
            })
            .unwrap();
        assert_eq!(stored, artifact);
    }

    #[test]
    fn migrates_v1_findings_to_review_scoped_identity_without_data_loss() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("goals.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection.execute(
            "INSERT INTO goal_runs(id, workflow_phase, workspace_path, started_at, updated_at, legacy, data_json)
             VALUES('run-1', 'specialist_review', '/tmp/repository', '2026-07-18T08:00:00Z', '2026-07-18T08:01:00Z', 0, '{}')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO review_results(id, run_id, reviewer_id, status, reviewed_at, data_json)
             VALUES('review-1', 'run-1', 'security', 'changes_requested', '2026-07-18T08:01:00Z', '{}')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO review_findings(id, run_id, review_id, severity, data_json)
             VALUES('stable-finding', 'run-1', 'review-1', 'high', '{\"id\":\"stable-finding\",\"severity\":\"high\"}')",
            [],
        ).unwrap();
        drop(connection);

        let repository = GoalRepository::open(directory.path()).unwrap();
        let connection = repository.connection().unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let retained: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM review_findings WHERE review_id = 'review-1' AND id = 'stable-finding'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);
        assert_eq!(retained, 1);
        drop(connection);

        let repeated_review = json!({
            "id": "review-2", "reviewerId": "security", "status": "changes_requested", "reviewedAt": "2026-07-18T08:02:00Z",
            "findings": [{ "id": "stable-finding", "severity": "high", "description": "The finding remains open" }]
        });
        for _ in 0..2 {
            repository
                .write(StorageWrite::UpsertReview {
                    run_id: "run-1".into(),
                    review: repeated_review.clone(),
                })
                .unwrap();
        }
        let repeated_count: i64 = repository
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM review_findings WHERE id = 'stable-finding'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repeated_count, 2);
    }

    #[test]
    fn rejects_database_versions_from_the_future() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("goals.sqlite3");
        let connection = Connection::open(database).unwrap();
        connection
            .pragma_update(None, "user_version", DATABASE_VERSION + 1)
            .unwrap();
        drop(connection);
        assert!(GoalRepository::open(directory.path())
            .unwrap_err()
            .contains("newer than supported"));
    }

    #[test]
    fn rolls_back_a_failed_migration_and_reports_corrupt_databases() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("goals.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute("CREATE TABLE goals (broken TEXT)", [])
            .unwrap();
        drop(connection);
        assert!(GoalRepository::open(directory.path()).is_err());
        let connection = Connection::open(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0);
        drop(connection);

        let corrupt_directory = tempfile::tempdir().unwrap();
        fs::write(
            corrupt_directory.path().join("goals.sqlite3"),
            "not a sqlite database",
        )
        .unwrap();
        assert!(GoalRepository::open(corrupt_directory.path()).is_err());
    }

    #[test]
    fn stores_and_restores_a_complete_partial_run_transactionally() {
        let (directory, repository) = repository();
        repository
            .write(StorageWrite::UpsertGoal { goal: goal() })
            .unwrap();
        repository
            .write(StorageWrite::InsertGoalVersion { version: version() })
            .unwrap();
        repository
            .write(StorageWrite::ReplaceQuestions {
                goal_id: "goal-1".into(),
                goal_version: 1,
                questions: vec![json!({ "id": "question-1", "type": "confirmation" })],
            })
            .unwrap();
        repository.write(StorageWrite::UpsertAnswer {
            goal_id: "goal-1".into(),
            answer: json!({ "questionId": "question-1", "value": true, "answeredAt": "2026-07-18T08:01:00Z" }),
        }).unwrap();
        repository
            .write(StorageWrite::UpsertRun { run: run() })
            .unwrap();
        for index in 0..2 {
            repository
                .write(StorageWrite::AppendEvent {
                    event: json!({
                        "id": format!("event-{index}"),
                        "runId": "run-1",
                        "type": "workflow_state_transitioned",
                        "occurredAt": "2026-07-18T08:01:00Z"
                    }),
                })
                .unwrap();
        }
        repository.write(StorageWrite::UpsertReview {
            run_id: "run-1".into(),
            review: json!({
                "id": "review-1", "reviewerId": "testing", "status": "needs_evidence", "reviewedAt": "2026-07-18T08:01:00Z",
                "findings": [{ "id": "finding-1", "severity": "medium", "description": "Need a regression test" }]
            }),
        }).unwrap();
        repository.write(StorageWrite::UpsertReview {
            run_id: "run-1".into(),
            review: json!({
                "id": "review-2", "reviewerId": "testing", "status": "changes_requested", "reviewedAt": "2026-07-18T08:02:00Z",
                "findings": [{ "id": "finding-1", "severity": "medium", "description": "The same regression gap remains" }]
            }),
        }).unwrap();
        repository.write(StorageWrite::UpsertReview {
            run_id: "run-1".into(),
            review: json!({
                "id": "review-2", "reviewerId": "testing", "status": "changes_requested", "reviewedAt": "2026-07-18T08:02:00Z",
                "findings": [{ "id": "finding-1", "severity": "medium", "description": "The same regression gap remains" }]
            }),
        }).unwrap();
        repository.write(StorageWrite::UpsertEvidenceRequest {
            run_id: "run-1".into(),
            request: json!({ "id": "request-1", "reviewerId": "testing", "status": "pending", "required": true, "requestedAt": "2026-07-18T08:01:00Z" }),
        }).unwrap();
        repository.write(StorageWrite::UpsertEvidenceItem {
            run_id: "run-1".into(),
            evidence: json!({ "id": "evidence-1", "type": "test", "freshness": { "status": "fresh" }, "collectedAt": "2026-07-18T08:01:00Z" }),
        }).unwrap();
        repository.write(StorageWrite::UpsertReport {
            report: json!({ "id": "report-1", "runId": "run-1", "overview": { "finalStatus": "blocked" }, "generatedAt": "2026-07-18T08:01:00Z" }),
        }).unwrap();

        drop(repository);
        let reopened = GoalRepository::open(directory.path()).unwrap();
        let snapshot = reopened.run_snapshot("run-1").unwrap();
        assert_eq!(
            snapshot.pointer("/run/id").and_then(Value::as_str),
            Some("run-1")
        );
        assert_eq!(snapshot["versions"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["questions"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["answers"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["events"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["reviews"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["findings"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["evidenceRequests"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(
            snapshot.pointer("/report/id").and_then(Value::as_str),
            Some("report-1")
        );
    }

    #[test]
    fn preserves_event_order_and_does_not_duplicate_legacy_imports() {
        let (_directory, repository) = repository();
        let legacy = json!({
            "id": "legacy-run", "goal": "Old goal", "status": "completed", "workspacePath": "/tmp/repository",
            "codingModelId": "codex/model", "judgeModelId": "openrouter/model", "iteration": 1, "maxIterations": 3,
            "iterations": [], "startedAt": "2026-07-18T08:00:00Z", "finishedAt": "2026-07-18T08:01:00Z"
        });
        let events = vec![
            json!({ "type": "run_started" }),
            json!({ "type": "run_completed" }),
        ];
        repository.import_legacy_run(&legacy, &events).unwrap();
        repository.import_legacy_run(&legacy, &events).unwrap();
        let snapshot = repository.run_snapshot("legacy-run").unwrap();
        assert_eq!(snapshot["events"].as_array().unwrap().len(), 2);
        assert_eq!(
            snapshot.pointer("/events/0/type").and_then(Value::as_str),
            Some("run_started")
        );
        assert!(snapshot["goal"].is_null());
    }

    #[test]
    fn legacy_import_rolls_back_if_any_event_is_invalid() {
        let (_directory, repository) = repository();
        let legacy = json!({
            "id": "legacy-run", "goal": "Old goal", "status": "running", "workspacePath": "/tmp/repository",
            "codingModelId": "codex/model", "judgeModelId": "openrouter/model", "iteration": 1, "maxIterations": 3,
            "iterations": [], "startedAt": "2026-07-18T08:00:00Z"
        });
        let events = vec![json!({ "type": "run_started" }), json!("invalid")];
        assert!(repository.import_legacy_run(&legacy, &events).is_err());
        assert!(repository.run_snapshot("legacy-run").unwrap().is_null());
    }

    #[test]
    fn writes_integrity_checked_artifacts_and_rejects_path_escape() {
        let (_directory, repository) = repository();
        repository.upsert_goal(&goal()).unwrap();
        repository.upsert_run(&run(), false).unwrap();
        let metadata = repository
            .write_artifact("run-1", "full command output", "text/plain")
            .unwrap();
        let restored = repository.read_artifact(&metadata.id).unwrap();
        assert_eq!(restored.content, "full command output");
        assert_eq!(restored.metadata.sha256, sha256(b"full command output"));

        repository
            .connection()
            .unwrap()
            .execute(
                "UPDATE artifacts SET relative_path = '../outside.txt' WHERE id = ?1",
                [&metadata.id],
            )
            .unwrap();
        assert!(repository
            .read_artifact(&metadata.id)
            .unwrap_err()
            .contains("outside"));
    }

    #[test]
    fn removes_only_untracked_artifacts_after_the_grace_period() {
        let (_directory, repository) = repository();
        repository.upsert_goal(&goal()).unwrap();
        repository.upsert_run(&run(), false).unwrap();
        let metadata = repository
            .write_artifact("run-1", "tracked", "text/plain")
            .unwrap();
        let orphan = repository.artifact_root.join("orphan.log");
        fs::write(&orphan, "orphan").unwrap();
        assert_eq!(
            repository.cleanup_orphan_artifacts(Duration::ZERO).unwrap(),
            1
        );
        assert!(!orphan.exists());
        assert!(repository.read_artifact(&metadata.id).is_ok());
    }

    #[test]
    fn deletes_runs_with_related_rows_and_artifact_files() {
        let (_directory, repository) = repository();
        repository.upsert_goal(&goal()).unwrap();
        repository.upsert_run(&run(), false).unwrap();
        repository.append_event(&json!({
            "id": "event-1", "runId": "run-1", "type": "goal_approved", "occurredAt": "2026-07-18T08:01:00Z"
        })).unwrap();
        let metadata = repository
            .write_artifact("run-1", "tracked", "text/plain")
            .unwrap();
        let artifact_path = repository
            .safe_artifact_path(&metadata.relative_path)
            .unwrap();

        repository.delete_run("run-1").unwrap();
        assert!(repository.run_snapshot("run-1").unwrap().is_null());
        assert!(!artifact_path.exists());
        assert!(repository.artifact_metadata(&metadata.id).is_err());
    }

    #[test]
    fn deletes_goal_history_without_deleting_a_durable_run() {
        let (_directory, repository) = repository();
        repository.upsert_goal(&goal()).unwrap();
        repository.insert_goal_version(&version()).unwrap();
        repository
            .replace_questions("goal-1", 1, &[json!({ "id": "question-1" })])
            .unwrap();
        repository
            .upsert_answer(
                "goal-1",
                &json!({
                    "questionId": "question-1", "answeredAt": "2026-07-18T08:01:00Z"
                }),
            )
            .unwrap();
        repository.upsert_run(&run(), false).unwrap();

        repository.delete_goal("goal-1").unwrap();
        assert!(repository
            .read_json_optional("SELECT data_json FROM goals WHERE id = ?1", "goal-1")
            .unwrap()
            .is_none());
        let snapshot = repository.run_snapshot("run-1").unwrap();
        assert_eq!(
            snapshot.pointer("/run/id").and_then(Value::as_str),
            Some("run-1")
        );
        assert!(snapshot["goal"].is_null());
        assert!(snapshot["versions"].as_array().unwrap().is_empty());
        assert!(snapshot["questions"].as_array().unwrap().is_empty());
        assert!(snapshot["answers"].as_array().unwrap().is_empty());
    }

    #[test]
    fn rolls_back_question_replacement_when_any_record_is_invalid() {
        let (_directory, repository) = repository();
        repository.upsert_goal(&goal()).unwrap();
        repository.insert_goal_version(&version()).unwrap();
        repository
            .replace_questions("goal-1", 1, &[json!({ "id": "valid" })])
            .unwrap();
        assert!(repository
            .replace_questions("goal-1", 1, &[json!({ "missing": "id" })])
            .is_err());
        let questions = read_json_list_on(
            &repository.connection().unwrap(),
            "SELECT data_json FROM goal_questions WHERE goal_id = ?1",
            "goal-1",
        )
        .unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["id"], "valid");
    }
}
