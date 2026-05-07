mod db;
mod firefox;
mod native_host;

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use chrono::{Duration, Local, NaiveDate};
use clap::{Args, Parser, Subcommand, ValueEnum};
use db::{ArchivedTab, Db, SearchRow};

#[derive(Parser)]
#[command(
    name = "bt",
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
    NativeHost,
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

    match cli.command {
        Commands::Doctor => doctor(&db_path),
        Commands::NativeHost => native_host::run(&db_path),
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
        "firefox: {}",
        if firefox::firefox_available() {
            "found"
        } else {
            "not found"
        }
    );
    Ok(())
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
            firefox::open_urls([url.to_string()])?;
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
            firefox::open_urls([url.to_string()])?;
        }
    }
    Ok(())
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
    Command::new(command)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
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
