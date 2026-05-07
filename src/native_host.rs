use std::io::{Read, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
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
        let result = handle_message(&db, message);
        match result {
            Ok(()) => write_message(&mut output, &json!({ "v": 1, "type": "ack", "ok": true }))?,
            Err(error) => write_message(
                &mut output,
                &json!({ "v": 1, "type": "error", "ok": false, "message": error.to_string() }),
            )?,
        }
    }

    Ok(())
}

fn handle_message(db: &Db, message: Value) -> Result<()> {
    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .context("missing message type")?;
    let payload = message.get("payload").unwrap_or(&message);

    match message_type {
        "hello" | "heartbeat" => Ok(()),
        "visit" | "navigation_event" => {
            let visit: IncomingVisit = serde_json::from_value(payload.clone())?;
            db.insert_visit(&visit)
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
            db.replace_current_tabs(&tabs, captured_at, reason)
        }
        "link_click_hint" => db.insert_link_hint(payload),
        other => bail!("unknown message type: {other}"),
    }
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
