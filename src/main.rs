mod db;
mod firefox;
mod native_host;

use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration as StdDuration;
use std::{env, fs};

use anyhow::{Context, Result, bail};
use chrono::{Duration, Local, NaiveDate};
use clap::{Args, Parser, Subcommand, ValueEnum};
use db::{ArchivedTab, CurrentTab, Db, SearchRow};
use serde_json::json;

const NATIVE_HOST_NAME: &str = "browser_opt";
const EXTENSION_ID: &str = "browser-opt@godin.local";

#[derive(Parser)]
#[command(
    name = "browser-opt",
    version,
    about = "Local-first Firefox tab archives and browser search"
)]
struct Cli {
    #[arg(long, global = true, value_name = "PATH")]
    db: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Doctor,
    InstallNativeHost {
        #[arg(value_name = "PATH")]
        browser_opt: Option<PathBuf>,
    },
    NativeHost,
    NativeHostServer {
        #[arg(long, default_value = "127.0.0.1:8765")]
        listen: String,
    },
    NativeHostProxy {
        #[arg(long, default_value = "127.0.0.1:8765")]
        server: String,
    },
    Search(SearchArgs),
    Fzf(FzfArgs),
    Archive {
        #[command(subcommand)]
        command: ArchiveCommand,
    },
    Recurring {
        #[command(subcommand)]
        command: RecurringCommand,
    },
    Export {
        path: PathBuf,
    },
    Import {
        path: PathBuf,
        #[arg(long)]
        replace: bool,
    },
}

#[derive(Args)]
struct SearchArgs {
    query: String,
    #[arg(long)]
    archives: bool,
    #[arg(long, default_value_t = 25)]
    limit: usize,
}

#[derive(Args)]
struct FzfArgs {
    mode: FzfMode,
    query: Option<String>,
}

#[derive(Clone, ValueEnum)]
enum FzfMode {
    All,
    Pages,
    Archives,
}

#[derive(Subcommand)]
enum ArchiveCommand {
    Today,
    Yesterday,
    Create { date: String },
    List,
    Show { date: String },
    Open { date: String },
}

#[derive(Subcommand)]
enum RecurringCommand {
    Create { name: String },
    Add { name: String, url: String },
    List,
    Show { name: String },
    Open { name: String },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let db_path = db::resolve_db_path(cli.db)?;
    if !matches!(
        &cli.command,
        Commands::InstallNativeHost { .. }
            | Commands::NativeHost
            | Commands::NativeHostServer { .. }
            | Commands::NativeHostProxy { .. }
    ) && let Err(error) = ensure_ttyd_running()
    {
        eprintln!("warning: failed to start ttyd: {error:#}");
    }

    match cli.command {
        Commands::Doctor => doctor(&db_path),
        Commands::InstallNativeHost { browser_opt } => install_native_host(browser_opt),
        Commands::NativeHost => native_host::run(&db_path),
        Commands::NativeHostServer { listen } => native_host::run_server(&db_path, &listen),
        Commands::NativeHostProxy { server } => native_host::run_proxy(&server),
        Commands::Search(args) => {
            let db = Db::open(&db_path)?;
            if args.archives {
                for row in db.search_archives(&args.query, args.limit)? {
                    print_archived_tab(&row);
                }
            } else {
                for row in db.search_pages(&args.query, args.limit)? {
                    print_search_row(&row);
                }
            }
            Ok(())
        }
        Commands::Fzf(args) => {
            let db = Db::open(&db_path)?;
            match args.mode {
                FzfMode::All => fzf_all(&db, args.query.as_deref()),
                FzfMode::Pages => fzf_pages(&db, args.query.as_deref()),
                FzfMode::Archives => fzf_archives(&db, args.query.as_deref()),
            }
        }
        Commands::Archive { command } => {
            let db = Db::open(&db_path)?;
            match command {
                ArchiveCommand::Today => archive_date(&db, Local::now().date_naive()),
                ArchiveCommand::Yesterday => {
                    archive_date(&db, Local::now().date_naive() - Duration::days(1))
                }
                ArchiveCommand::Create { date } => archive_date(&db, parse_date(&date)?),
                ArchiveCommand::List => {
                    for archive in db.list_archives()? {
                        println!(
                            "{}\t{} tabs\t{} visits",
                            archive.date, archive.tab_count, archive.visit_count
                        );
                    }
                    Ok(())
                }
                ArchiveCommand::Show { date } => {
                    for tab in db.archived_tabs(&date)? {
                        print_archived_tab(&tab);
                    }
                    Ok(())
                }
                ArchiveCommand::Open { date } => open_missing(
                    &db,
                    db.archived_tabs(&date)?
                        .into_iter()
                        .map(|tab| tab.url)
                        .collect(),
                ),
            }
        }
        Commands::Recurring { command } => {
            let db = Db::open(&db_path)?;
            match command {
                RecurringCommand::Create { name } => {
                    db.create_recurring_set(&name)?;
                    println!("created recurring set: {name}");
                    Ok(())
                }
                RecurringCommand::Add { name, url } => {
                    db.add_recurring_url(&name, &url)?;
                    println!("added to {name}: {url}");
                    Ok(())
                }
                RecurringCommand::List => {
                    for set in db.list_recurring_sets()? {
                        println!("{}\t{} urls", set.name, set.url_count);
                    }
                    Ok(())
                }
                RecurringCommand::Show { name } => {
                    for url in db.recurring_urls(&name)? {
                        println!("{}\t{}", url.position, url.url);
                    }
                    Ok(())
                }
                RecurringCommand::Open { name } => {
                    let urls = db
                        .recurring_urls(&name)?
                        .into_iter()
                        .map(|url| url.url)
                        .collect();
                    open_missing(&db, urls)
                }
            }
        }
        Commands::Export { path } => export_db(&db_path, path),
        Commands::Import { path, replace } => import_db(&db_path, path, replace),
    }
}

fn ensure_ttyd_running() -> Result<()> {
    let addr: SocketAddr = "127.0.0.1:7681".parse()?;
    if TcpStream::connect_timeout(&addr, StdDuration::from_millis(100)).is_ok() {
        return Ok(());
    }

    let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sh");
    let shell_path = shell.to_string_lossy().into_owned();

    let mut command = Command::new("ttyd");
    command.args([
        "-i",
        "127.0.0.1",
        "-p",
        "7681",
        "-W",
        "-t",
        "macOptionIsMeta=true",
        "-t",
        "macOptionClickForcesSelection=true",
        "-t",
        "fontFamily=JetBrainsMono Nerd Font Mono,JetBrainsMono Nerd Font,monospace",
        "-t",
        "rendererType=canvas",
        "-t",
        "smoothScrollDuration=0",
        "-t",
        "scrollback=2000",
        "-t",
        "disableResizeOverlay=true",
        "-t",
        "titleFixed= browser-opt",
        "-w",
        env!("CARGO_MANIFEST_DIR"),
    ]);

    if cfg!(target_os = "macos") {
        let user = env::var("USER").context("USER not set")?;
        command
            .arg("/usr/bin/login")
            .args(["-flp", &user, &shell_path, "-fc"])
            .arg(format!("exec -a -{shell_name} {shell_path}"));
    } else {
        command.arg(shell).arg("-l");
    }

    command
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to spawn ttyd")?;

    Ok(())
}

fn doctor(db_path: &PathBuf) -> Result<()> {
    let db = Db::open(db_path)?;
    println!("database: {}", db_path.display());
    println!("sqlite: ok");
    println!(
        "fts5: {}",
        if db.fts5_enabled()? {
            "ok"
        } else {
            "unavailable"
        }
    );
    println!(
        "fzf: {}",
        if command_exists("fzf") {
            "found"
        } else {
            "not found"
        }
    );
    println!(
        "ttyd: {}",
        if command_exists("ttyd") {
            "found"
        } else {
            "not found"
        }
    );
    println!(
        "tmux: {}",
        if command_exists("tmux") {
            "found"
        } else {
            "not found"
        }
    );
    println!(
        "firefox: {}",
        if firefox::firefox_available() {
            "found"
        } else {
            "not found"
        }
    );
    match native_host_manifest_path() {
        Ok(path) => println!(
            "native host manifest: {}",
            if path.exists() {
                path.display().to_string()
            } else {
                "not installed".to_string()
            }
        ),
        Err(error) => println!("native host manifest: unavailable ({error})"),
    }
    Ok(())
}

fn install_native_host(browser_opt: Option<PathBuf>) -> Result<()> {
    let binary_path = match browser_opt {
        Some(path) => path,
        None => env::current_exe().context("failed to locate current executable")?,
    };
    let binary_path = canonicalize_existing_executable(&binary_path)?;
    let manifest_path = native_host_manifest_path()?;
    let host_dir = manifest_path
        .parent()
        .context("native host manifest path has no parent")?;
    fs::create_dir_all(host_dir)
        .with_context(|| format!("failed to create {}", host_dir.display()))?;

    let wrapper_path = host_dir.join("browser_opt_host");
    fs::write(
        &wrapper_path,
        format!(
            "#!/usr/bin/env bash\nexec {:?} native-host-proxy\n",
            binary_path
        ),
    )
    .with_context(|| format!("failed to write {}", wrapper_path.display()))?;
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("failed to make {} executable", wrapper_path.display()))?;

    let manifest = serde_json::to_string_pretty(&json!({
        "name": NATIVE_HOST_NAME,
        "description": "Browser Opt native messaging host",
        "path": wrapper_path.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }))?;
    fs::write(&manifest_path, format!("{manifest}\n"))
        .with_context(|| format!("failed to write {}", manifest_path.display()))?;

    println!(
        "installed native messaging host wrapper: {}",
        wrapper_path.display()
    );
    println!(
        "installed native messaging host manifest: {}",
        manifest_path.display()
    );
    println!("allowed Firefox extension: {EXTENSION_ID}");
    Ok(())
}

fn canonicalize_existing_executable(path: &Path) -> Result<PathBuf> {
    let path =
        fs::canonicalize(path).with_context(|| format!("failed to resolve {}", path.display()))?;
    let metadata =
        fs::metadata(&path).with_context(|| format!("failed to inspect {}", path.display()))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        bail!(
            "browser-opt executable not found or not executable: {}",
            path.display()
        );
    }
    Ok(path)
}

fn native_host_manifest_path() -> Result<PathBuf> {
    match env::consts::OS {
        "macos" => Ok(home_dir()?
            .join("Library/Application Support/Mozilla/NativeMessagingHosts/browser_opt.json")),
        "linux" => Ok(home_dir()?.join(".mozilla/native-messaging-hosts/browser_opt.json")),
        other => bail!("unsupported OS for Firefox native messaging: {other}"),
    }
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .context("HOME is not set")
}

fn archive_date(db: &Db, date: NaiveDate) -> Result<()> {
    let created = db.create_archive_for_date(date)?;
    println!(
        "archived {}: {} tabs, {} visits",
        date, created.tab_count, created.visit_count
    );
    Ok(())
}

fn parse_date(date: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").with_context(|| format!("invalid date: {date}"))
}

fn fzf_pages(db: &Db, query: Option<&str>) -> Result<()> {
    let rows = match query {
        Some(query) => db.search_pages(query, 200)?,
        None => db.recent_pages(200)?,
    };
    let input = rows
        .iter()
        .map(|row| {
            format!(
                "{}\t{}\t{}\t{}",
                row.visited_at,
                row.title.as_deref().unwrap_or(""),
                row.url,
                row.source_url.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let selected = run_fzf(&input)?;
    if let Some(line) = selected {
        if let Some(url) = line.split('\t').nth(2) {
            queue_open_url(db, url)?;
        }
    }
    Ok(())
}

fn fzf_all(db: &Db, query: Option<&str>) -> Result<()> {
    let current_tabs = match query {
        Some(query) => db.search_current_tabs(query, 200)?,
        None => db.current_tabs(200)?,
    };
    let pages = match query {
        Some(query) => db.search_pages(query, 200)?,
        None => db.recent_pages(200)?,
    };
    let archived_tabs = match query {
        Some(query) => db.search_archives(query, 200)?,
        None => db.recent_archived_tabs(200)?,
    };

    let input = current_tabs
        .iter()
        .map(format_current_tab_fzf_row)
        .chain(pages.iter().map(format_page_fzf_row))
        .chain(archived_tabs.iter().map(format_archive_fzf_row))
        .collect::<Vec<_>>()
        .join("\n");

    let selected = run_fzf(&input)?;
    if let Some(line) = selected {
        if let Some(url) = line.split('\t').nth(3) {
            queue_open_url(db, url)?;
        }
    }
    Ok(())
}

fn fzf_archives(db: &Db, query: Option<&str>) -> Result<()> {
    let rows = match query {
        Some(query) => db.search_archives(query, 200)?,
        None => db.recent_archived_tabs(200)?,
    };
    let input = rows
        .iter()
        .map(|row| {
            format!(
                "{}\t{}\t{}\t{}",
                row.archive_date,
                row.title.as_deref().unwrap_or(""),
                row.url,
                row.captured_at
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let selected = run_fzf(&input)?;
    if let Some(line) = selected {
        if let Some(url) = line.split('\t').nth(2) {
            queue_open_url(db, url)?;
        }
    }
    Ok(())
}

fn format_current_tab_fzf_row(row: &CurrentTab) -> String {
    let flags = match (row.active, row.pinned) {
        (true, true) => "active,pinned",
        (true, false) => "active",
        (false, true) => "pinned",
        (false, false) => "",
    };
    format!(
        "current\t{}\t{}\t{}\t{}",
        row.updated_at,
        row.title.as_deref().unwrap_or(""),
        row.url,
        flags
    )
}

fn format_page_fzf_row(row: &SearchRow) -> String {
    format!(
        "visited\t{}\t{}\t{}\t{}",
        row.visited_at,
        row.title.as_deref().unwrap_or(""),
        row.url,
        row.source_url.as_deref().unwrap_or("")
    )
}

fn format_archive_fzf_row(row: &ArchivedTab) -> String {
    format!(
        "archived\t{}\t{}\t{}\t{}",
        row.archive_date,
        row.title.as_deref().unwrap_or(""),
        row.url,
        row.captured_at
    )
}

fn run_fzf(input: &str) -> Result<Option<String>> {
    if input.trim().is_empty() {
        return Ok(None);
    }

    let mut child = Command::new("fzf")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("failed to run fzf")?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(input.as_bytes())?;
    }

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Ok(None);
    }

    let selected = String::from_utf8(output.stdout)?.trim().to_string();
    Ok((!selected.is_empty()).then_some(selected))
}

fn open_missing(db: &Db, urls: Vec<String>) -> Result<()> {
    let missing = db.missing_urls(urls)?;
    if missing.is_empty() {
        println!("all URLs are already open");
        return Ok(());
    }
    firefox::open_urls(missing.iter().cloned())?;
    println!("opened {} missing URLs", missing.len());
    Ok(())
}

fn queue_open_url(db: &Db, url: &str) -> Result<()> {
    db.queue_open_url(url)?;
    println!("queued open request: {url}");
    Ok(())
}

fn export_db(db_path: &PathBuf, destination: PathBuf) -> Result<()> {
    let db = Db::open(db_path)?;
    db.checkpoint()?;
    fs::copy(db_path, &destination)
        .with_context(|| format!("failed to export to {}", destination.display()))?;
    println!("exported database to {}", destination.display());
    Ok(())
}

fn import_db(db_path: &PathBuf, source: PathBuf, replace: bool) -> Result<()> {
    if db_path.exists() && !replace {
        bail!(
            "database already exists; pass --replace to overwrite {}",
            db_path.display()
        );
    }
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, db_path)
        .with_context(|| format!("failed to import from {}", source.display()))?;
    println!("imported database from {}", source.display());
    Ok(())
}

fn command_exists(command: &str) -> bool {
    env::var_os("PATH").is_some_and(|path| {
        env::split_paths(&path).any(|directory| directory.join(command).is_file())
    })
}

fn print_search_row(row: &SearchRow) {
    println!(
        "{}\t{}\t{}\t{}",
        row.visited_at,
        row.title.as_deref().unwrap_or(""),
        row.url,
        row.source_url.as_deref().unwrap_or("")
    );
}

fn print_archived_tab(row: &ArchivedTab) {
    println!(
        "{}\t{}\t{}\t{}",
        row.archive_date,
        row.title.as_deref().unwrap_or(""),
        row.url,
        row.captured_at
    );
}
