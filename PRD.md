# Browser Opt PRD

## Problem

Browser state is ephemeral and hard to search. Firefox can restore sessions and store history, but it does not provide a local-first workflow for daily tab archives, recurring tab sets, and CLI-driven search over visited pages.

## Goal

Build a Firefox extension plus local CLI that records browser activity to disk, creates searchable daily tab archives, and lets the user reopen recurring named tab sets from the command line.

## Target User

A power user who lives in Firefox, uses the terminal heavily, and wants browser state to be searchable, restorable, and scriptable without relying on cloud sync.

## V1 Scope

- Firefox extension captures open tabs and browsing activity.
- Native messaging host writes events to a local SQLite database.
- SQLite uses FTS5 for URL/title/source search.
- CLI searches archived tabs and visited pages.
- CLI integrates with `fzf`.
- Daily archives contain both an open-tab snapshot and activity trail grouped by local calendar day.
- Recurring tabs are organized into named sets.
- Recurring tab sets are opened manually from CLI.
- Opening a recurring set opens only missing URLs to avoid duplicates.
- Source-page capture is best effort.
- Linux and macOS are supported in v1.
- Data is local-first with explicit export/import.

## Non-Goals For V1

- Windows support.
- Cloud sync.
- Automatic scheduled tab opening.
- Required encryption at rest.
- Perfect source/referrer tracking.
- Full personal search engine over page contents.
- Privacy denylist, pause capture, or delete tooling beyond normal local file control.

## Core Workflows

Daily archive:

```bash
browser-opt archive today
browser-opt archive yesterday
browser-opt archive list
browser-opt archive open 2026-05-07
```

Search visited pages:

```bash
browser-opt search "sqlite fts firefox"
browser-opt fzf pages
```

Search archives:

```bash
browser-opt fzf archives
browser-opt archive open 2026-05-07
```

Recurring tabs:

```bash
browser-opt recurring create work
browser-opt recurring add work https://github.com
browser-opt recurring add work https://calendar.google.com
browser-opt recurring open work
```

Export/import:

```bash
browser-opt export ./browser-opt-export.sqlite
browser-opt import ./browser-opt-export.sqlite
```

## Data Model Concepts

- `page_visit`: a committed page visit or meaningful URL/title update.
- `tab_snapshot`: state of a tab at a point in time.
- `daily_archive`: local-date grouping of tab snapshots and activity.
- `recurring_set`: named collection of URLs.
- `source_hint`: best-effort relationship between a destination URL and where it came from.

## Source URL Capture

V1 should not promise perfect "where did this URL come from?" tracking.

Acceptable sources:

- Content script observes normal link clicks and records current page URL plus clicked target.
- Browser navigation/referrer metadata is used when available.
- Missing source is allowed.
- Address-bar entries, bookmarks, redirects, and many SPA transitions may have no reliable source.

Acceptance criterion:

- For ordinary clicked links on standard web pages, source URL is often captured.
- If source capture is unavailable, the visit is still recorded.

## Architecture

```text
Firefox Extension
  captures tabs, navigation events, link-click hints
        |
        v
Native Messaging Host
  validates and normalizes events
        |
        v
SQLite + FTS5
  local durable datastore
        |
        v
CLI
  search, fzf, archive restore, recurring sets, export/import
        |
        v
Firefox
  opens selected URLs/tabs
```

## Key Product Decisions

- Primary product: all-in-one browser state manager.
- V1 priority: daily tab archives.
- Capture scope: snapshot plus activity trail.
- Datastore: SQLite with FTS5.
- Extension write path: native messaging host.
- Archive boundary: local calendar day.
- Recurring trigger: manual CLI only.
- Recurring organization: named sets.
- Open behavior: open missing URLs only.
- Search behavior: separate modes for visited pages and archives.
- Privacy posture: local storage with explicit export/import.

## Acceptance Criteria

- User can install extension and native host on Linux/macOS.
- Open tabs are captured into SQLite.
- Visited pages are captured with URL, title, timestamp, and optional source URL.
- A daily archive can be listed and reopened.
- `browser-opt fzf pages` lets the user fuzzy-search visited pages and open a selected URL.
- `browser-opt fzf archives` lets the user fuzzy-search daily archives or archived tabs.
- `browser-opt fzf all` lets the user fuzzy-search current tabs, visited pages, and archived tabs together.
- User can create a named recurring set and open it from CLI.
- Opening a recurring set does not duplicate URLs already open in Firefox.
- Data remains local unless the user explicitly exports it.

## Open Questions

- Should archives restore into the current window or a new window?
- Should the CLI also provide a short alias such as `bopt`?
- Should closed tabs be tracked as first-class archive entries, or only visits/open snapshots?
- Should private browsing be ignored entirely by default?
- Should export produce raw SQLite, JSONL, or both?
