use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;

use anyhow::{Context, Result, bail};
use chrono::{Local, NaiveDate, TimeZone, Utc};
use serde_json::{Value, json};

use crate::db::{Db, IncomingTab, IncomingVisit};

const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

pub fn run(db_path: &Path) -> Result<()> {
    let db = Db::open(db_path)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();

    while let Some(message) = read_message(&mut input)? {
        let request_id = message.get("requestId").cloned();
        let result = handle_message(&db, message);
        match result {
            Ok(payload) => write_message(
                &mut output,
                &json!({ "v": 1, "type": "ack", "ok": true, "requestId": request_id, "payload": payload }),
            )?,
            Err(error) => write_message(
                &mut output,
                &json!({ "v": 1, "type": "error", "ok": false, "requestId": request_id, "message": error.to_string() }),
            )?,
        }
    }

    Ok(())
}

pub fn run_server(db_path: &Path, listen: &str) -> Result<()> {
    let listener = TcpListener::bind(listen).with_context(|| format!("failed to bind {listen}"))?;
    eprintln!("browser-opt native host server listening on {listen}");

    for stream in listener.incoming() {
        let stream = stream.context("failed to accept native host proxy connection")?;
        let db_path = db_path.to_path_buf();
        thread::spawn(move || {
            if let Err(error) = handle_proxy_connection(db_path, stream) {
                eprintln!("browser-opt native host proxy connection failed: {error:#}");
            }
        });
    }

    Ok(())
}

pub fn run_proxy(server: &str) -> Result<()> {
    let mut stream = TcpStream::connect(server)
        .with_context(|| format!("failed to connect to native host server at {server}"))?;
    let mut server_reader = BufReader::new(stream.try_clone()?);
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();

    while let Some(message) = read_message(&mut input)? {
        serde_json::to_writer(&mut stream, &message)?;
        stream.write_all(b"\n")?;
        stream.flush()?;

        let mut response = String::new();
        if server_reader.read_line(&mut response)? == 0 {
            bail!("native host server closed the proxy connection");
        }
        let response: Value = serde_json::from_str(&response)?;
        write_message(&mut output, &response)?;
    }

    Ok(())
}

fn handle_proxy_connection(db_path: PathBuf, mut stream: TcpStream) -> Result<()> {
    let db = Db::open(&db_path)?;
    let mut input = BufReader::new(stream.try_clone()?);

    loop {
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }

        let message: Value = serde_json::from_str(&line)?;
        let request_id = message.get("requestId").cloned();
        let response = match handle_message(&db, message) {
            Ok(payload) => {
                json!({ "v": 1, "type": "ack", "ok": true, "requestId": request_id, "payload": payload })
            }
            Err(error) => {
                json!({ "v": 1, "type": "error", "ok": false, "requestId": request_id, "message": error.to_string() })
            }
        };
        serde_json::to_writer(&mut stream, &response)?;
        stream.write_all(b"\n")?;
        stream.flush()?;
    }
}

fn handle_message(db: &Db, message: Value) -> Result<Value> {
    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .context("missing message type")?;
    let payload = message.get("payload").unwrap_or(&message);

    match message_type {
        "hello" | "heartbeat" => Ok(json!(null)),
        "visit" | "navigation_event" => {
            let visit: IncomingVisit = serde_json::from_value(payload.clone())?;
            db.insert_visit(&visit)?;
            Ok(json!(null))
        }
        "tab_snapshot" | "tabs_snapshot" => {
            let tabs = payload.get("tabs").cloned().context("missing tabs")?;
            let tabs: Vec<IncomingTab> = serde_json::from_value(tabs)?;
            let captured_at = payload
                .get("captured_at")
                .or_else(|| payload.get("capturedAt"))
                .and_then(Value::as_str);
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("native-message");
            db.replace_current_tabs(&tabs, captured_at, reason)?;
            Ok(json!(null))
        }
        "archive_tabs" => {
            let tabs = payload.get("tabs").cloned().context("missing tabs")?;
            let tabs: Vec<IncomingTab> = serde_json::from_value(tabs)?;
            let date = payload
                .get("date")
                .and_then(Value::as_str)
                .map(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d"))
                .transpose()
                .context("invalid archive date")?
                .unwrap_or_else(|| Local::now().date_naive());
            let summary = db.add_tabs_to_archive(date, &tabs)?;
            Ok(json!({
                "date": summary.date,
                "tabCount": summary.tab_count,
                "visitCount": summary.visit_count,
            }))
        }
        "archive_tab_snapshot" => {
            let tabs = payload.get("tabs").cloned().context("missing tabs")?;
            let tabs: Vec<IncomingTab> = serde_json::from_value(tabs)?;
            let date = payload
                .get("date")
                .and_then(Value::as_str)
                .map(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d"))
                .transpose()
                .context("invalid archive date")?
                .unwrap_or_else(|| Local::now().date_naive());
            let captured_at = payload
                .get("captured_at")
                .or_else(|| payload.get("capturedAt"))
                .and_then(Value::as_str);
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("daily-archive");
            let summary = db.archive_tab_snapshot(date, &tabs, captured_at, reason)?;
            Ok(json!({
                "date": summary.date,
                "tabCount": summary.tab_count,
                "visitCount": summary.visit_count,
            }))
        }
        "link_click_hint" => {
            db.insert_link_hint(payload)?;
            Ok(json!(null))
        }
        "pending_open_requests" => {
            let requests = db
                .pending_open_requests(25)?
                .into_iter()
                .map(|request| json!({ "id": request.id, "url": request.url }))
                .collect::<Vec<_>>();
            Ok(json!({ "requests": requests }))
        }
        "archived_tabs" => {
            let query = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(200) as usize;
            let tabs = if query.is_empty() {
                db.recent_archived_tabs(limit)?
            } else {
                db.search_archives_like(query, limit)?
            }
            .into_iter()
            .map(|tab| {
                json!({
                    "archiveDate": tab.archive_date,
                    "url": tab.url,
                    "title": tab.title,
                    "capturedAt": tab.captured_at,
                })
            })
            .collect::<Vec<_>>();
            Ok(json!({ "tabs": tabs }))
        }
        "mark_open_requests_handled" => {
            let ids = payload
                .get("ids")
                .and_then(Value::as_array)
                .context("missing ids")?
                .iter()
                .filter_map(Value::as_i64)
                .collect::<Vec<_>>();
            db.mark_open_requests_handled(&ids)?;
            Ok(json!(null))
        }
        "firefox_last_accessed_tabs" => firefox_last_accessed_tabs(),
        other => bail!("unknown message type: {other}"),
    }
}

fn firefox_last_accessed_tabs() -> Result<Value> {
    let session_path = firefox_session_path()?;
    let bytes = fs::read(&session_path)
        .with_context(|| format!("failed to read {}", session_path.display()))?;
    let json_bytes = decompress_moz_lz4(&bytes)?;
    let session: Value = serde_json::from_slice(&json_bytes)?;
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();

    for window in session
        .get("windows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for tab in window
            .get("tabs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(entries) = tab.get("entries").and_then(Value::as_array) else {
                continue;
            };
            let index = tab
                .get("index")
                .and_then(Value::as_i64)
                .unwrap_or(entries.len() as i64)
                - 1;
            let Some(entry) = entries.get(index.max(0) as usize) else {
                continue;
            };
            let Some(url) = entry.get("url").and_then(Value::as_str) else {
                continue;
            };
            if !url.starts_with("http://") && !url.starts_with("https://") {
                continue;
            }

            let accessed_at = tab
                .get("lastAccessed")
                .and_then(Value::as_i64)
                .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
                .unwrap_or_else(Utc::now);
            let date = accessed_at.with_timezone(&Local).date_naive().to_string();
            groups.entry(date).or_default().push(json!({
                "url": url,
                "title": entry.get("title").and_then(Value::as_str),
                "lastAccessed": accessed_at.to_rfc3339(),
            }));
        }
    }

    let groups = groups
        .into_iter()
        .rev()
        .map(|(date, tabs)| json!({ "date": date, "tabs": tabs }))
        .collect::<Vec<_>>();
    Ok(json!({ "sessionPath": session_path, "groups": groups }))
}

fn firefox_session_path() -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME").context("HOME is not set")?;
    let profiles = Path::new(&home).join("Library/Application Support/Firefox/Profiles");
    let mut candidates = Vec::new();
    for profile in fs::read_dir(&profiles)
        .with_context(|| format!("failed to read Firefox profiles at {}", profiles.display()))?
    {
        let profile = profile?.path();
        for relative in [
            "sessionstore-backups/recovery.jsonlz4",
            "sessionstore-backups/recovery.baklz4",
            "sessionstore.jsonlz4",
        ] {
            let path = profile.join(relative);
            if let Ok(metadata) = fs::metadata(&path) {
                candidates.push((metadata.modified()?, path));
            }
        }
    }
    candidates
        .into_iter()
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
        .context("could not find a Firefox session recovery file")
}

fn decompress_moz_lz4(bytes: &[u8]) -> Result<Vec<u8>> {
    if !bytes.starts_with(b"mozLz40\0") || bytes.len() < 12 {
        bail!("not a Firefox mozLz4 session file");
    }
    decompress_lz4_block(&bytes[12..])
}

fn decompress_lz4_block(input: &[u8]) -> Result<Vec<u8>> {
    let mut pos = 0;
    let mut output = Vec::new();
    while pos < input.len() {
        let token = input[pos];
        pos += 1;

        let mut literal_len = (token >> 4) as usize;
        if literal_len == 15 {
            loop {
                let byte = *input.get(pos).context("truncated LZ4 literal length")? as usize;
                pos += 1;
                literal_len += byte;
                if byte != 255 {
                    break;
                }
            }
        }
        let literals_end = pos + literal_len;
        if literals_end > input.len() {
            bail!("truncated LZ4 literals");
        }
        output.extend_from_slice(&input[pos..literals_end]);
        pos = literals_end;
        if pos >= input.len() {
            break;
        }

        if pos + 2 > input.len() {
            bail!("truncated LZ4 offset");
        }
        let offset = u16::from_le_bytes([input[pos], input[pos + 1]]) as usize;
        pos += 2;
        if offset == 0 || offset > output.len() {
            bail!("invalid LZ4 offset");
        }

        let mut match_len = (token & 0x0f) as usize;
        if match_len == 15 {
            loop {
                let byte = *input.get(pos).context("truncated LZ4 match length")? as usize;
                pos += 1;
                match_len += byte;
                if byte != 255 {
                    break;
                }
            }
        }
        match_len += 4;
        let start = output.len() - offset;
        for i in 0..match_len {
            output.push(output[start + i]);
        }
    }
    Ok(output)
}

fn read_message<R: Read>(reader: &mut R) -> Result<Option<Value>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }

    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_MESSAGE_BYTES {
        bail!("native message too large: {length} bytes");
    }

    let mut buffer = vec![0_u8; length];
    reader.read_exact(&mut buffer)?;
    Ok(Some(serde_json::from_slice(&buffer)?))
}

fn write_message<W: Write>(writer: &mut W, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    writer.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}
