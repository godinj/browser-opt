use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Local, NaiveDate, Utc};
use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

pub struct Db {
    conn: Connection,
}

#[derive(Debug)]
pub struct SearchRow {
    pub url: String,
    pub title: Option<String>,
    pub visited_at: String,
    pub source_url: Option<String>,
}

#[derive(Debug)]
pub struct ArchivedTab {
    pub archive_date: String,
    pub url: String,
    pub title: Option<String>,
    pub captured_at: String,
}

#[derive(Debug)]
pub struct CurrentTab {
    pub url: String,
    pub title: Option<String>,
    pub updated_at: String,
    pub active: bool,
    pub pinned: bool,
}

pub struct ArchiveSummary {
    pub date: String,
    pub tab_count: i64,
    pub visit_count: i64,
}

pub struct RecurringSetSummary {
    pub name: String,
    pub url_count: i64,
}

pub struct RecurringUrl {
    pub url: String,
    pub position: i64,
}

pub struct OpenRequest {
    pub id: i64,
    pub url: String,
}

#[derive(Deserialize)]
pub struct IncomingVisit {
    #[serde(alias = "targetUrl")]
    pub url: String,
    pub title: Option<String>,
    #[serde(alias = "visitedAt", alias = "timeStamp")]
    pub visited_at: Option<Value>,
    #[serde(alias = "sourceUrl")]
    pub source_url: Option<String>,
    #[serde(alias = "sourceTitle")]
    pub source_title: Option<String>,
    #[serde(alias = "tabId")]
    pub tab_id: Option<i64>,
    #[serde(alias = "windowId")]
    pub window_id: Option<i64>,
    #[serde(alias = "transitionType")]
    pub transition_type: Option<String>,
}

#[derive(Deserialize)]
pub struct IncomingTab {
    #[serde(alias = "tabId")]
    pub tab_id: i64,
    #[serde(alias = "windowId")]
    pub window_id: i64,
    pub url: Option<String>,
    pub title: Option<String>,
    pub active: Option<bool>,
    pub pinned: Option<bool>,
    pub discarded: Option<bool>,
    pub position: Option<i64>,
}

pub fn resolve_db_path(override_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = override_path {
        return Ok(path);
    }

    let dirs = ProjectDirs::from("local", "godin", "browser-opt")
        .ok_or_else(|| anyhow!("could not resolve data directory"))?;
    Ok(dirs.data_dir().join("browser-opt.sqlite"))
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open database at {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn fts5_enabled(&self) -> Result<bool> {
        let result: i64 = self.conn.query_row(
            "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
            [],
            |row| row.get(0),
        )?;
        Ok(result == 1
            || self
                .conn
                .execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_probe USING fts5(value)",
                    [],
                )
                .is_ok())
    }

    pub fn checkpoint(&self) -> Result<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    pub fn insert_visit(&self, visit: &IncomingVisit) -> Result<()> {
        let url = clean_url(&visit.url).context("visit missing valid url")?;
        let normalized_url = normalize_url(&url);
        let visited_at = value_timestamp(visit.visited_at.as_ref()).unwrap_or_else(now_string);

        self.conn.execute(
            "INSERT INTO page_visit (url, normalized_url, title, visited_at, source_url, source_title, tab_id, window_id, transition_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![url, normalized_url, visit.title, visited_at, visit.source_url, visit.source_title, visit.tab_id, visit.window_id, visit.transition_type],
        )?;
        Ok(())
    }

    pub fn insert_link_hint(&self, payload: &Value) -> Result<()> {
        let target = payload
            .get("targetUrl")
            .or_else(|| payload.get("url"))
            .and_then(Value::as_str)
            .context("missing targetUrl")?;
        let source_url = payload
            .get("sourceUrl")
            .and_then(Value::as_str)
            .map(str::to_string);
        let visit = IncomingVisit {
            url: target.to_string(),
            title: None,
            visited_at: payload
                .get("clickedAt")
                .or_else(|| payload.get("sentAt"))
                .cloned(),
            source_url,
            source_title: None,
            tab_id: payload.get("tabId").and_then(Value::as_i64),
            window_id: payload.get("windowId").and_then(Value::as_i64),
            transition_type: Some("link_hint".to_string()),
        };
        self.insert_visit(&visit)
    }

    pub fn replace_current_tabs(
        &self,
        tabs: &[IncomingTab],
        captured_at: Option<&str>,
        reason: &str,
    ) -> Result<()> {
        let captured_at = captured_at.map(str::to_string).unwrap_or_else(now_string);
        let local_date = local_date_for_timestamp(&captured_at);
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM current_tab", [])?;
        tx.execute(
            "INSERT INTO tab_snapshot (captured_at, local_date, reason) VALUES (?1, ?2, ?3)",
            params![captured_at, local_date, reason],
        )?;
        let snapshot_id = tx.last_insert_rowid();

        for tab in tabs
            .iter()
            .filter(|tab| tab.url.as_deref().is_some_and(is_http_url))
        {
            let url = tab.url.clone().unwrap_or_default();
            let normalized_url = normalize_url(&url);
            tx.execute(
                "INSERT INTO current_tab (tab_id, window_id, url, normalized_url, title, active, pinned, discarded, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![tab.tab_id, tab.window_id, url, normalized_url, tab.title, bool_int(tab.active), bool_int(tab.pinned), bool_int(tab.discarded), captured_at],
            )?;
            tx.execute(
                "INSERT INTO tab_snapshot_item (snapshot_id, tab_id, window_id, url, normalized_url, title, position, active, pinned, captured_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![snapshot_id, tab.tab_id, tab.window_id, tab.url, normalize_url(tab.url.as_deref().unwrap_or_default()), tab.title, tab.position, bool_int(tab.active), bool_int(tab.pinned), captured_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn search_pages(&self, query: &str, limit: usize) -> Result<Vec<SearchRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT page_visit.url, page_visit.title, page_visit.visited_at, page_visit.source_url
             FROM page_visit_fts
             JOIN page_visit ON page_visit.id = page_visit_fts.rowid
             WHERE page_visit_fts MATCH ?1
             ORDER BY rank, page_visit.visited_at DESC
             LIMIT ?2",
        )?;
        collect_search_rows(&mut stmt, params![query, limit as i64])
    }

    pub fn recent_pages(&self, limit: usize) -> Result<Vec<SearchRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT url, title, visited_at, source_url FROM page_visit ORDER BY visited_at DESC LIMIT ?1",
        )?;
        collect_search_rows(&mut stmt, params![limit as i64])
    }

    pub fn search_current_tabs(&self, query: &str, limit: usize) -> Result<Vec<CurrentTab>> {
        let pattern = format!("%{query}%");
        let mut stmt = self.conn.prepare(
            "SELECT url, title, updated_at, active, pinned
             FROM current_tab
             WHERE url LIKE ?1 OR title LIKE ?1
             ORDER BY active DESC, pinned DESC, updated_at DESC
             LIMIT ?2",
        )?;
        collect_current_tabs(&mut stmt, params![pattern, limit as i64])
    }

    pub fn current_tabs(&self, limit: usize) -> Result<Vec<CurrentTab>> {
        let mut stmt = self.conn.prepare(
            "SELECT url, title, updated_at, active, pinned
             FROM current_tab
             ORDER BY active DESC, pinned DESC, updated_at DESC
             LIMIT ?1",
        )?;
        collect_current_tabs(&mut stmt, params![limit as i64])
    }

    pub fn create_archive_for_date(&self, date: NaiveDate) -> Result<ArchiveSummary> {
        let date = date.to_string();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO daily_archive (archive_date) VALUES (?1)",
            params![date],
        )?;
        let archive_id: i64 = tx.query_row(
            "SELECT id FROM daily_archive WHERE archive_date = ?1",
            params![date],
            |row| row.get(0),
        )?;
        tx.execute(
            "DELETE FROM archived_tab WHERE archive_id = ?1",
            params![archive_id],
        )?;
        tx.execute(
            "DELETE FROM archive_visit WHERE archive_id = ?1",
            params![archive_id],
        )?;
        tx.execute(
            "INSERT INTO archived_tab (archive_id, url, normalized_url, title, window_id, position, active, pinned, captured_at)
             SELECT ?1, url, normalized_url, title, window_id, NULL, active, pinned, updated_at FROM current_tab ORDER BY window_id, tab_id",
            params![archive_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO archive_visit (archive_id, page_visit_id)
             SELECT ?1, id FROM page_visit WHERE substr(visited_at, 1, 10) = ?2",
            params![archive_id, date],
        )?;
        tx.commit()?;
        self.archive_summary(&date)
    }

    pub fn list_archives(&self) -> Result<Vec<ArchiveSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT daily_archive.archive_date,
                    COUNT(DISTINCT archived_tab.id),
                    COUNT(DISTINCT archive_visit.page_visit_id)
             FROM daily_archive
             LEFT JOIN archived_tab ON archived_tab.archive_id = daily_archive.id
             LEFT JOIN archive_visit ON archive_visit.archive_id = daily_archive.id
             GROUP BY daily_archive.id
             ORDER BY daily_archive.archive_date DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ArchiveSummary {
                date: row.get(0)?,
                tab_count: row.get(1)?,
                visit_count: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn archived_tabs(&self, date: &str) -> Result<Vec<ArchivedTab>> {
        let mut stmt = self.conn.prepare(
            "SELECT daily_archive.archive_date, archived_tab.url, archived_tab.title, archived_tab.captured_at
             FROM archived_tab
             JOIN daily_archive ON daily_archive.id = archived_tab.archive_id
             WHERE daily_archive.archive_date = ?1
             ORDER BY archived_tab.window_id, archived_tab.position, archived_tab.id",
        )?;
        collect_archived_tabs(&mut stmt, params![date])
    }

    pub fn search_archives(&self, query: &str, limit: usize) -> Result<Vec<ArchivedTab>> {
        let mut stmt = self.conn.prepare(
            "SELECT daily_archive.archive_date, archived_tab.url, archived_tab.title, archived_tab.captured_at
             FROM archived_tab_fts
             JOIN archived_tab ON archived_tab.id = archived_tab_fts.rowid
             JOIN daily_archive ON daily_archive.id = archived_tab.archive_id
             WHERE archived_tab_fts MATCH ?1
             ORDER BY rank, daily_archive.archive_date DESC
             LIMIT ?2",
        )?;
        collect_archived_tabs(&mut stmt, params![query, limit as i64])
    }

    pub fn search_archives_like(&self, query: &str, limit: usize) -> Result<Vec<ArchivedTab>> {
        let pattern = format!("%{query}%");
        let mut stmt = self.conn.prepare(
            "SELECT daily_archive.archive_date, archived_tab.url, archived_tab.title, archived_tab.captured_at
             FROM archived_tab
             JOIN daily_archive ON daily_archive.id = archived_tab.archive_id
             WHERE archived_tab.url LIKE ?1 OR archived_tab.title LIKE ?1 OR daily_archive.archive_date LIKE ?1
             ORDER BY daily_archive.archive_date DESC, archived_tab.id DESC
             LIMIT ?2",
        )?;
        collect_archived_tabs(&mut stmt, params![pattern, limit as i64])
    }

    pub fn recent_archived_tabs(&self, limit: usize) -> Result<Vec<ArchivedTab>> {
        let mut stmt = self.conn.prepare(
            "SELECT daily_archive.archive_date, archived_tab.url, archived_tab.title, archived_tab.captured_at
             FROM archived_tab
             JOIN daily_archive ON daily_archive.id = archived_tab.archive_id
             ORDER BY daily_archive.archive_date DESC, archived_tab.id DESC
             LIMIT ?1",
        )?;
        collect_archived_tabs(&mut stmt, params![limit as i64])
    }

    pub fn create_recurring_set(&self, name: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO recurring_set (name) VALUES (?1)",
            params![name],
        )?;
        Ok(())
    }

    pub fn add_recurring_url(&self, name: &str, url: &str) -> Result<()> {
        let url = clean_url(url).context("invalid url")?;
        let normalized_url = normalize_url(&url);
        let set_id = self
            .recurring_set_id(name)?
            .ok_or_else(|| anyhow!("unknown recurring set: {name}"))?;
        let position: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM recurring_url WHERE set_id = ?1",
            params![set_id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO recurring_url (set_id, url, normalized_url, position) VALUES (?1, ?2, ?3, ?4)",
            params![set_id, url, normalized_url, position],
        )?;
        Ok(())
    }

    pub fn list_recurring_sets(&self) -> Result<Vec<RecurringSetSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT recurring_set.name, COUNT(recurring_url.id)
             FROM recurring_set
             LEFT JOIN recurring_url ON recurring_url.set_id = recurring_set.id
             GROUP BY recurring_set.id
             ORDER BY recurring_set.name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RecurringSetSummary {
                name: row.get(0)?,
                url_count: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn recurring_urls(&self, name: &str) -> Result<Vec<RecurringUrl>> {
        let mut stmt = self.conn.prepare(
            "SELECT recurring_url.url, recurring_url.position
             FROM recurring_url
             JOIN recurring_set ON recurring_set.id = recurring_url.set_id
             WHERE recurring_set.name = ?1
             ORDER BY recurring_url.position",
        )?;
        let rows = stmt.query_map(params![name], |row| {
            Ok(RecurringUrl {
                url: row.get(0)?,
                position: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn missing_urls(&self, urls: Vec<String>) -> Result<Vec<String>> {
        let mut missing = Vec::new();
        for url in urls {
            let normalized_url = normalize_url(&url);
            let exists: Option<i64> = self
                .conn
                .query_row(
                    "SELECT 1 FROM current_tab WHERE normalized_url = ?1 LIMIT 1",
                    params![normalized_url],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                missing.push(url);
            }
        }
        Ok(missing)
    }

    pub fn queue_open_url(&self, url: &str) -> Result<()> {
        let url = clean_url(url).context("invalid url")?;
        let normalized_url = normalize_url(&url);
        self.conn.execute(
            "INSERT INTO open_request (url, normalized_url, requested_at) VALUES (?1, ?2, ?3)",
            params![url, normalized_url, now_string()],
        )?;
        Ok(())
    }

    pub fn pending_open_requests(&self, limit: usize) -> Result<Vec<OpenRequest>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, url FROM open_request WHERE handled_at IS NULL ORDER BY id LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(OpenRequest {
                id: row.get(0)?,
                url: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn mark_open_requests_handled(&self, ids: &[i64]) -> Result<()> {
        let handled_at = now_string();
        for id in ids {
            self.conn.execute(
                "UPDATE open_request SET handled_at = ?1 WHERE id = ?2",
                params![handled_at, id],
            )?;
        }
        Ok(())
    }

    fn archive_summary(&self, date: &str) -> Result<ArchiveSummary> {
        self.conn
            .query_row(
                "SELECT daily_archive.archive_date,
                    COUNT(DISTINCT archived_tab.id),
                    COUNT(DISTINCT archive_visit.page_visit_id)
             FROM daily_archive
             LEFT JOIN archived_tab ON archived_tab.archive_id = daily_archive.id
             LEFT JOIN archive_visit ON archive_visit.archive_id = daily_archive.id
             WHERE daily_archive.archive_date = ?1
             GROUP BY daily_archive.id",
                params![date],
                |row| {
                    Ok(ArchiveSummary {
                        date: row.get(0)?,
                        tab_count: row.get(1)?,
                        visit_count: row.get(2)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn recurring_set_id(&self, name: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM recurring_set WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(SCHEMA)?;
        Ok(())
    }
}

fn collect_search_rows<P>(stmt: &mut rusqlite::Statement<'_>, params: P) -> Result<Vec<SearchRow>>
where
    P: rusqlite::Params,
{
    let rows = stmt.query_map(params, |row| {
        Ok(SearchRow {
            url: row.get(0)?,
            title: row.get(1)?,
            visited_at: row.get(2)?,
            source_url: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn collect_archived_tabs<P>(
    stmt: &mut rusqlite::Statement<'_>,
    params: P,
) -> Result<Vec<ArchivedTab>>
where
    P: rusqlite::Params,
{
    let rows = stmt.query_map(params, |row| {
        Ok(ArchivedTab {
            archive_date: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            captured_at: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn collect_current_tabs<P>(stmt: &mut rusqlite::Statement<'_>, params: P) -> Result<Vec<CurrentTab>>
where
    P: rusqlite::Params,
{
    let rows = stmt.query_map(params, |row| {
        Ok(CurrentTab {
            url: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            active: row.get::<_, i64>(3)? != 0,
            pinned: row.get::<_, i64>(4)? != 0,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn clean_url(input: &str) -> Option<String> {
    is_http_url(input).then(|| input.to_string())
}

fn is_http_url(input: &str) -> bool {
    Url::parse(input).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn normalize_url(input: &str) -> String {
    let Ok(mut url) = Url::parse(input) else {
        return input.to_string();
    };
    url.set_fragment(None);
    url.set_scheme(&url.scheme().to_ascii_lowercase()).ok();
    if let Some(host) = url.host_str().map(str::to_ascii_lowercase) {
        url.set_host(Some(&host)).ok();
    }
    url.to_string()
}

fn bool_int(value: Option<bool>) -> i64 {
    i64::from(value.unwrap_or(false))
}

fn now_string() -> String {
    Utc::now().to_rfc3339()
}

fn value_timestamp(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => value
            .as_f64()
            .and_then(|millis| DateTime::<Utc>::from_timestamp_millis(millis as i64))
            .map(|dt| dt.to_rfc3339()),
        _ => None,
    }
}

fn local_date_for_timestamp(timestamp: &str) -> String {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.with_timezone(&Local).date_naive().to_string())
        .unwrap_or_else(|_| Local::now().date_naive().to_string())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS page_visit (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  visited_at TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  tab_id INTEGER,
  window_id INTEGER,
  transition_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_visit_visited_at ON page_visit(visited_at);
CREATE INDEX IF NOT EXISTS idx_page_visit_normalized_url ON page_visit(normalized_url);

CREATE VIRTUAL TABLE IF NOT EXISTS page_visit_fts USING fts5(
  url,
  title,
  source_url,
  source_title,
  content='page_visit',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS page_visit_ai AFTER INSERT ON page_visit BEGIN
  INSERT INTO page_visit_fts(rowid, url, title, source_url, source_title)
  VALUES (new.id, new.url, new.title, new.source_url, new.source_title);
END;

CREATE TRIGGER IF NOT EXISTS page_visit_ad AFTER DELETE ON page_visit BEGIN
  INSERT INTO page_visit_fts(page_visit_fts, rowid, url, title, source_url, source_title)
  VALUES ('delete', old.id, old.url, old.title, old.source_url, old.source_title);
END;

CREATE TRIGGER IF NOT EXISTS page_visit_au AFTER UPDATE ON page_visit BEGIN
  INSERT INTO page_visit_fts(page_visit_fts, rowid, url, title, source_url, source_title)
  VALUES ('delete', old.id, old.url, old.title, old.source_url, old.source_title);

  INSERT INTO page_visit_fts(rowid, url, title, source_url, source_title)
  VALUES (new.id, new.url, new.title, new.source_url, new.source_title);
END;

CREATE TABLE IF NOT EXISTS current_tab (
  tab_id INTEGER PRIMARY KEY,
  window_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  discarded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_current_tab_normalized_url ON current_tab(normalized_url);

CREATE TABLE IF NOT EXISTS tab_snapshot (
  id INTEGER PRIMARY KEY,
  captured_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tab_snapshot_item (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES tab_snapshot(id) ON DELETE CASCADE,
  tab_id INTEGER,
  window_id INTEGER,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  position INTEGER,
  active INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_archive (
  id INTEGER PRIMARY KEY,
  archive_date TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT
);

CREATE TABLE IF NOT EXISTS archived_tab (
  id INTEGER PRIMARY KEY,
  archive_id INTEGER NOT NULL REFERENCES daily_archive(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  window_id INTEGER,
  position INTEGER,
  active INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS archived_tab_fts USING fts5(
  url,
  title,
  content='archived_tab',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS archived_tab_ai AFTER INSERT ON archived_tab BEGIN
  INSERT INTO archived_tab_fts(rowid, url, title)
  VALUES (new.id, new.url, new.title);
END;

CREATE TRIGGER IF NOT EXISTS archived_tab_ad AFTER DELETE ON archived_tab BEGIN
  INSERT INTO archived_tab_fts(archived_tab_fts, rowid, url, title)
  VALUES ('delete', old.id, old.url, old.title);
END;

CREATE TRIGGER IF NOT EXISTS archived_tab_au AFTER UPDATE ON archived_tab BEGIN
  INSERT INTO archived_tab_fts(archived_tab_fts, rowid, url, title)
  VALUES ('delete', old.id, old.url, old.title);

  INSERT INTO archived_tab_fts(rowid, url, title)
  VALUES (new.id, new.url, new.title);
END;

CREATE TABLE IF NOT EXISTS archive_visit (
  archive_id INTEGER NOT NULL REFERENCES daily_archive(id) ON DELETE CASCADE,
  page_visit_id INTEGER NOT NULL REFERENCES page_visit(id) ON DELETE CASCADE,
  PRIMARY KEY (archive_id, page_visit_id)
);

CREATE TABLE IF NOT EXISTS recurring_set (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recurring_url (
  id INTEGER PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES recurring_set(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(set_id, normalized_url)
);

CREATE TABLE IF NOT EXISTS open_request (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  handled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_open_request_handled_at ON open_request(handled_at, id);
"#;
