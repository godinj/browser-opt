use std::process::{Command, Stdio};

use anyhow::{Context, Result};

pub fn firefox_available() -> bool {
    Command::new(firefox_command())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub fn open_urls<I>(urls: I) -> Result<()>
where
    I: IntoIterator<Item = String>,
{
    for url in urls {
        if cfg!(target_os = "macos") {
            Command::new("open")
                .args(["-a", "Firefox", &url])
                .status()
                .with_context(|| format!("failed to open {url}"))?;
        } else {
            Command::new(firefox_command())
                .args(["--new-tab", &url])
                .status()
                .with_context(|| format!("failed to open {url}"))?;
        }
    }
    Ok(())
}

fn firefox_command() -> &'static str {
    "firefox"
}
