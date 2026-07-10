const status = document.getElementById("status");
const searchInput = document.getElementById("tab-search");
const tabResults = document.getElementById("tab-results");
const actionInput = document.getElementById("action-search");
const actionResults = document.getElementById("action-results");
const archiveInput = document.getElementById("archive-search");
const archiveResults = document.getElementById("archive-results");
const tabPanel = document.getElementById("tab-panel");
const actionPanel = document.getElementById("action-panel");
const archivePanel = document.getElementById("archive-panel");
const modeTitle = document.getElementById("mode-title");
const modeDescription = document.getElementById("mode-description");
const promptDialog = document.getElementById("prompt-dialog");
const promptForm = document.getElementById("prompt-form");
const promptTitle = document.getElementById("prompt-title");
const promptDescription = document.getElementById("prompt-description");
const promptInput = document.getElementById("prompt-input");
const promptCancel = document.getElementById("prompt-cancel");

const requestedMode = new URLSearchParams(location.search).get("mode");
const mode = ["tabs", "actions", "history"].includes(requestedMode) ? requestedMode : "tabs";

const modeMetadata = {
  tabs: {
    title: "Open tabs",
    description: "Find an open tab without leaving the keyboard.",
  },
  actions: {
    title: "Quick actions",
    description: "Run Browser Opt and Tree Style Tab workflows.",
  },
  history: {
    title: "Tab archive",
    description: "Reopen tabs saved in your local daily archives.",
  },
};

let tabs = [];
let renderedTabs = [];
let renderedActions = [];
let renderedArchivedTabs = [];
let archiveSearchTimer = null;
let archiveRequestId = 0;
let resolvePrompt = null;

const icons = {
  archive: '<path d="M3 3v3h3M3.5 5.5A5 5 0 1 1 3 9M8 5.25V8l2 1.25"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M5 2v3M11 2v3M2.5 7h11M5 9.5h1M8 9.5h1"/>',
  cleanup: '<path d="M3 4h10M5 4V2.5h6V4M5 7v5M8 7v5M11 7v5M4 4l.7 10h6.6L12 4"/>',
  folder: '<path d="M2 4.5h4l1.5 2H14v6.5H2z"/>',
  merge: '<path d="M3 3v2c0 2 1 3 3 3h4M8 5l3 3-3 3M3 13v-2c0-2 1-3 3-3"/>',
  rename: '<path d="M3 12.5h3l7-7-3-3-7 7zM8.5 4l3 3"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m4.5 6 2 2-2 2M8.5 10h3"/>',
};

const actions = [
  {
    title: "Open web terminal",
    description: "Open or focus the local Browser Opt terminal.",
    type: "browser-opt:open-terminal",
    runningLabel: "Opening terminal",
    icon: "terminal",
    badge: "Terminal",
  },
  {
    title: "Group tabs by last accessed date",
    description: "Build Tree Style Tab date folders from Firefox session data.",
    type: "browser-opt:group-by-date",
    runningLabel: "Grouping tabs",
    icon: "calendar",
    badge: "TST",
  },
  {
    title: "Clean up date groups",
    description: "Promote date folders and remove non-date category folders.",
    type: "browser-opt:cleanup-date-groups",
    runningLabel: "Cleaning up TST folders",
    icon: "cleanup",
    badge: "TST",
    keywords: "move delete category folders",
  },
  {
    title: "Archive selected folders",
    description: "Save highlighted TST folders, or the active folder, locally.",
    type: "browser-opt:archive-current-folder",
    runningLabel: "Archiving selected folders",
    icon: "archive",
    badge: "Local",
  },
  {
    title: "Archive and close selected folders",
    description: "Save the selected folders, then close their tabs.",
    type: "browser-opt:archive-and-close-current-folder",
    runningLabel: "Archiving and closing selected folders",
    icon: "archive",
    badge: "Closes tabs",
    tone: "danger",
  },
  {
    title: "Group selected tabs into folder",
    description: "Create a named Tree Style Tab folder from selected tabs.",
    type: "browser-opt:group-selected-tabs",
    runningLabel: "Grouping selected tabs",
    icon: "folder",
    badge: "TST",
    prompt: {
      title: "Name this tab folder",
      description: "Choose a short name for the selected Tree Style Tab tabs.",
      defaultValue: "Selected Tabs",
    },
  },
  {
    title: "Rename active tab",
    description: "Set a custom title for the active tab or TST folder.",
    type: "browser-opt:rename-active-tab",
    runningLabel: "Renaming active tab",
    icon: "rename",
    badge: "Tab",
    prompt: {
      title: "Rename active tab",
      description: "Enter the title you want Firefox to display.",
      defaultValue: "",
    },
  },
  {
    title: "Merge and sort date folders",
    description: "Deduplicate date folders and sort them newest first.",
    type: "browser-opt:sort-date-groups",
    runningLabel: "Merging and sorting date folders",
    icon: "merge",
    badge: "TST",
  },
];

function normalize(text) {
  return (text || "").toLocaleLowerCase();
}

function matchesQuery(text, query) {
  const normalizedText = normalize(text);
  return normalize(query).split(/\s+/).filter(Boolean).every(term => normalizedText.includes(term));
}

function resultText(tab) {
  return `${tab.title || ""} ${tab.url || ""}`;
}

function actionText(action) {
  return `${action.title} ${action.description} ${action.keywords || ""} ${action.badge || ""}`;
}

function archivedTabText(tab) {
  return `${tab.title || ""} ${tab.url || ""} ${tab.archiveDate || ""}`;
}

function displayUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return `${url.hostname}${path === "/" ? "" : path}`;
  } catch (_) {
    return value;
  }
}

function fallbackLetter(tab) {
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "").charAt(0).toUpperCase() || "•";
  } catch (_) {
    return (tab.title || "•").charAt(0).toUpperCase();
  }
}

function createSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = icons[name] || icons.archive;
  return svg;
}

function createEmptyState(title, detail, { loading = false } = {}) {
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const content = document.createElement("div");
  const heading = document.createElement("strong");
  if (loading) {
    const dot = document.createElement("span");
    dot.className = "loading-dot";
    dot.setAttribute("aria-hidden", "true");
    heading.append(dot);
  }
  heading.append(document.createTextNode(title));

  const description = document.createElement("span");
  description.textContent = detail;
  content.append(heading, description);
  empty.append(content);
  return empty;
}

function setStatus(message = "", tone = "info") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function createTabResult(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `result tab-result${tab.current ? " active" : ""}`;
  button.title = tab.url || tab.title || "Untitled tab";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", tab.current ? "true" : "false");

  const visual = document.createElement("span");
  visual.className = "tab-icon-wrap";

  const fallback = document.createElement("span");
  fallback.className = "tab-fallback";
  fallback.textContent = fallbackLetter(tab);
  visual.append(fallback);

  if (tab.favIconUrl) {
    const icon = document.createElement("img");
    icon.className = "tab-icon";
    icon.alt = "";
    icon.src = tab.favIconUrl;
    fallback.hidden = true;
    icon.addEventListener("error", () => {
      icon.hidden = true;
      fallback.hidden = false;
    }, { once: true });
    visual.prepend(icon);
  }

  const copy = document.createElement("span");
  copy.className = "result-copy";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = tab.title || "Untitled tab";
  const url = document.createElement("span");
  url.className = "result-detail";
  url.textContent = displayUrl(tab.url);
  copy.append(title, url);

  const badge = document.createElement("span");
  badge.className = "result-badge";
  badge.textContent = tab.current ? "Current" : (tab.pinned ? "Pinned" : "");
  if (!badge.textContent) badge.hidden = true;

  button.append(visual, copy, badge);
  button.addEventListener("click", () => focusTab(tab));
  return button;
}

function createActionResult(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result action-result";
  button.setAttribute("role", "option");

  const icon = document.createElement("span");
  icon.className = "action-icon";
  icon.append(createSvg(action.icon));

  const copy = document.createElement("span");
  copy.className = "result-copy";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = action.title;
  const description = document.createElement("span");
  description.className = "result-detail action-description";
  description.textContent = action.description;
  copy.append(title, description);

  const badge = document.createElement("span");
  badge.className = `result-badge${action.tone === "danger" ? " danger" : ""}`;
  badge.textContent = action.badge || "";

  button.append(icon, copy, badge);
  button.addEventListener("click", () => runAction(action));
  return button;
}

function createArchiveResult(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result archive-result";
  button.title = tab.url || tab.title || "Archived tab";
  button.setAttribute("role", "option");

  const icon = document.createElement("span");
  icon.className = "archive-icon";
  icon.append(createSvg("archive"));

  const copy = document.createElement("span");
  copy.className = "result-copy";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = tab.title || "Untitled archived tab";
  const url = document.createElement("span");
  url.className = "result-detail";
  url.textContent = displayUrl(tab.url);
  copy.append(title, url);

  const date = document.createElement("span");
  date.className = "result-badge";
  date.textContent = tab.archiveDate || "Archived";

  button.append(icon, copy, date);
  button.addEventListener("click", () => openArchivedTab(tab));
  return button;
}

function renderTabs() {
  const query = searchInput.value.trim();
  const matchingTabs = tabs
    .filter(tab => !query || matchesQuery(resultText(tab), query))
    .sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.pinned) - Number(a.pinned)
      || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))
    .slice(0, 50);
  renderedTabs = matchingTabs;

  tabResults.textContent = "";
  if (!matchingTabs.length) {
    tabResults.append(createEmptyState(
      tabs.length ? "No matching tabs" : "No open tabs found",
      tabs.length ? "Try a title, site, or part of a URL." : "Open a tab in Firefox and it will appear here."
    ));
    return;
  }

  for (const tab of matchingTabs) tabResults.append(createTabResult(tab));
}

function renderActions() {
  const query = actionInput.value.trim();
  const matchingActions = actions.filter(action => !query || matchesQuery(actionText(action), query));
  renderedActions = matchingActions;

  actionResults.textContent = "";
  if (!matchingActions.length) {
    actionResults.append(createEmptyState("No matching actions", "Try a workflow name such as archive, group, or terminal."));
    return;
  }

  for (const action of matchingActions) actionResults.append(createActionResult(action));
}

function renderArchivedTabs({ loading = false } = {}) {
  archiveResults.textContent = "";
  if (loading) {
    archiveResults.append(createEmptyState("Searching your archive", "Browser Opt keeps this history on your machine.", { loading: true }));
    return;
  }

  if (!renderedArchivedTabs.length) {
    archiveResults.append(createEmptyState(
      archiveInput.value.trim() ? "No matching archived tabs" : "No archived tabs found",
      archiveInput.value.trim() ? "Try a broader title or URL." : "Archived folders and daily snapshots will appear here."
    ));
    return;
  }

  for (const tab of renderedArchivedTabs) archiveResults.append(createArchiveResult(tab));
}

function resultButtons(container) {
  return Array.from(container.querySelectorAll("button[role='option']:not(:disabled)"));
}

function visibleStep(container, buttons) {
  if (!buttons.length) return 1;
  const buttonHeight = buttons[0].getBoundingClientRect().height || 1;
  return Math.max(1, Math.floor(container.clientHeight / buttonHeight / 2));
}

function focusResult(container, offset) {
  const buttons = resultButtons(container);
  if (!buttons.length) return;

  const currentIndex = buttons.indexOf(document.activeElement);
  const startIndex = currentIndex === -1 ? (offset < 0 ? buttons.length : -1) : currentIndex;
  const nextIndex = Math.min(buttons.length - 1, Math.max(0, startIndex + offset));
  buttons[nextIndex].focus();
  buttons[nextIndex].scrollIntoView({ block: "nearest" });
}

function focusBoundary(container, boundary) {
  const buttons = resultButtons(container);
  if (!buttons.length) return;
  const button = boundary === "end" ? buttons[buttons.length - 1] : buttons[0];
  button.focus();
  button.scrollIntoView({ block: "nearest" });
}

async function loadTabs() {
  const [source, openTabs] = await Promise.all([
    browser.runtime.sendMessage({ type: "browser-opt:popup-source" }),
    browser.tabs.query({}),
  ]);
  const popupUrl = browser.runtime.getURL("popup.html");
  tabs = openTabs
    .filter(tab => !tab.url || !tab.url.startsWith(popupUrl))
    .map(tab => ({
      ...tab,
      current: tab.id === source.tabId,
    }));
  modeDescription.textContent = `${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"} across Firefox.`;
  renderTabs();
}

async function loadArchivedTabs() {
  const requestId = ++archiveRequestId;
  const query = archiveInput.value.trim();
  renderArchivedTabs({ loading: true });
  const result = await browser.runtime.sendMessage({
    type: "browser-opt:archived-tabs",
    query,
    limit: 50,
  });
  if (requestId !== archiveRequestId) return;

  renderedArchivedTabs = (result && result.tabs) || [];
  if (query) {
    renderedArchivedTabs = renderedArchivedTabs.filter(tab => matchesQuery(archivedTabText(tab), query));
  }
  modeDescription.textContent = renderedArchivedTabs.length
    ? `${renderedArchivedTabs.length} archived ${renderedArchivedTabs.length === 1 ? "tab" : "tabs"} ready to reopen.`
    : modeMetadata.history.description;
  renderArchivedTabs();
}

async function focusTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
  window.close();
}

async function openArchivedTab(tab) {
  if (!tab.url) return;
  setStatus("Opening archived tab…");
  try {
    await browser.runtime.sendMessage({ type: "browser-opt:open-url", url: tab.url });
    window.close();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function showPrompt(options) {
  promptTitle.textContent = options.title;
  promptDescription.textContent = options.description;
  promptInput.value = options.defaultValue || "";
  promptDialog.classList.remove("hidden");
  promptInput.focus();
  promptInput.select();
  return new Promise(resolve => {
    resolvePrompt = resolve;
  });
}

function finishPrompt(value) {
  if (!resolvePrompt) return;
  const resolve = resolvePrompt;
  resolvePrompt = null;
  promptDialog.classList.add("hidden");
  resolve(value);
}

function setActionsDisabled(disabled) {
  for (const button of actionResults.querySelectorAll("button")) button.disabled = disabled;
  actionResults.setAttribute("aria-busy", String(disabled));
}

async function runAction(action) {
  const payload = { type: action.type };
  if (action.prompt) {
    const title = await showPrompt(action.prompt);
    if (!title) {
      setStatus("Action cancelled.");
      actionInput.focus();
      return;
    }
    payload.title = title;
  }

  setStatus(`${action.runningLabel}…`);
  setActionsDisabled(true);
  try {
    const result = await browser.runtime.sendMessage(payload);
    setStatus(result && result.message ? result.message : "Done.", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setActionsDisabled(false);
  }
}

function handleSearchKeydown(event, renderedItems, runFirstItem, container) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusResult(container, 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    focusResult(container, -1);
  } else if (event.key === "Enter" && renderedItems.length) {
    event.preventDefault();
    runFirstItem(renderedItems[0]);
  }
}

function handleResultsKeydown(event, container, input) {
  const noModifier = !event.ctrlKey && !event.metaKey && !event.altKey;
  if ((event.key === "ArrowDown" || event.key === "j") && noModifier) {
    event.preventDefault();
    focusResult(container, 1);
  } else if ((event.key === "ArrowUp" || event.key === "k") && noModifier) {
    event.preventDefault();
    focusResult(container, -1);
  } else if (event.key === "d" && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, visibleStep(container, resultButtons(container)));
  } else if (event.key === "u" && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, -visibleStep(container, resultButtons(container)));
  } else if (event.key === "Home" && noModifier) {
    event.preventDefault();
    focusBoundary(container, "start");
  } else if (event.key === "End" && noModifier) {
    event.preventDefault();
    focusBoundary(container, "end");
  } else if (event.key === "/" && noModifier) {
    event.preventDefault();
    input.focus();
  }
}

function activateMode() {
  const metadata = modeMetadata[mode];
  modeTitle.textContent = metadata.title;
  modeDescription.textContent = metadata.description;
  document.title = `${metadata.title} — Browser Opt`;

  for (const link of document.querySelectorAll(".mode-link")) {
    if (link.dataset.mode === mode) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  tabPanel.classList.toggle("hidden", mode !== "tabs");
  actionPanel.classList.toggle("hidden", mode !== "actions");
  archivePanel.classList.toggle("hidden", mode !== "history");
}

async function localizeShortcutHints() {
  const platform = await browser.runtime.getPlatformInfo().catch(() => ({ os: "mac" }));
  const prefix = platform.os === "mac" ? "⌘⇧" : "Ctrl+Shift+";
  for (const hint of document.querySelectorAll("[data-shortcut]")) {
    hint.textContent = `${prefix}${hint.dataset.shortcut}`;
  }
}

promptForm.addEventListener("submit", event => {
  event.preventDefault();
  const value = promptInput.value.trim();
  if (value) finishPrompt(value);
});
promptCancel.addEventListener("click", () => finishPrompt(null));
promptDialog.addEventListener("click", event => {
  if (event.target === promptDialog) finishPrompt(null);
});
promptDialog.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    finishPrompt(null);
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !promptDialog.classList.contains("hidden")) return;
  const activeInput = mode === "tabs" ? searchInput : (mode === "actions" ? actionInput : archiveInput);
  if (activeInput.value) {
    activeInput.value = "";
    activeInput.dispatchEvent(new Event("input"));
    activeInput.focus();
  } else {
    window.close();
  }
});

activateMode();
localizeShortcutHints();

if (mode === "actions") {
  renderActions();
  actionInput.addEventListener("input", renderActions);
  actionInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedActions, runAction, actionResults));
  actionResults.addEventListener("keydown", event => handleResultsKeydown(event, actionResults, actionInput));
  actionInput.focus();
} else if (mode === "history") {
  archiveInput.addEventListener("input", () => {
    clearTimeout(archiveSearchTimer);
    archiveSearchTimer = setTimeout(() => {
      loadArchivedTabs().catch(error => {
        renderedArchivedTabs = [];
        renderArchivedTabs();
        setStatus(error.message || String(error), "error");
      });
    }, 140);
  });
  archiveInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedArchivedTabs, openArchivedTab, archiveResults));
  archiveResults.addEventListener("keydown", event => handleResultsKeydown(event, archiveResults, archiveInput));
  loadArchivedTabs().catch(error => {
    renderedArchivedTabs = [];
    renderArchivedTabs();
    setStatus(error.message || String(error), "error");
  });
  archiveInput.focus();
} else {
  searchInput.addEventListener("input", renderTabs);
  searchInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedTabs, focusTab, tabResults));
  tabResults.addEventListener("keydown", event => handleResultsKeydown(event, tabResults, searchInput));
  loadTabs().catch(error => {
    tabResults.textContent = "";
    tabResults.append(createEmptyState("Could not read Firefox tabs", error.message || String(error)));
    setStatus(error.message || String(error), "error");
  });
  searchInput.focus();
}
