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
const requestedMode = new URLSearchParams(location.search).get("mode");
const mode = ["actions", "history"].includes(requestedMode) ? requestedMode : "tabs";
let tabs = [];
let renderedTabs = [];
let renderedActions = [];
let renderedArchivedTabs = [];
let archiveSearchTimer = null;

const actions = [
  {
    title: "Active tab search",
    description: "Search open tabs and focus the selected tab.",
    mode: "tabs",
  },
  {
    title: "Archived tab search",
    description: "Search historical tabs saved in daily archives.",
    mode: "history",
  },
  {
    title: "Open web terminal",
    description: "Open the local Browser Opt ttyd session.",
    type: "browser-opt:open-terminal",
    runningLabel: "Opening terminal",
  },
  {
    title: "Group tabs by last accessed date",
    description: "Create Tree Style Tab date groups from Firefox session access data.",
    type: "browser-opt:group-by-date",
    runningLabel: "Grouping tabs",
  },
  {
    title: "Move date groups out, delete category folders",
    description: "Promote date folders and remove non-date TST category folders.",
    type: "browser-opt:cleanup-date-groups",
    runningLabel: "Cleaning up TST folders",
  },
  {
    title: "Archive selected folders",
    description: "Save tabs from highlighted TST folders, or the active folder, to archives.",
    type: "browser-opt:archive-current-folder",
    runningLabel: "Archiving selected folders",
  },
  {
    title: "Archive and close selected folders",
    description: "Save tabs from highlighted TST folders, or the active folder, then close them.",
    type: "browser-opt:archive-and-close-current-folder",
    runningLabel: "Archiving and closing selected folders",
  },
  {
    title: "Group selected tabs into folder",
    description: "Create a Tree Style Tab folder from the selected TST tabs.",
    type: "browser-opt:group-selected-tabs",
    runningLabel: "Grouping selected tabs",
    promptTitle: true,
  },
  {
    title: "Rename active tab",
    description: "Set a custom title for the active tab or Tree Style Tab folder.",
    type: "browser-opt:rename-active-tab",
    runningLabel: "Renaming active tab",
    promptRenameTitle: true,
  },
  {
    title: "Merge and sort date folders",
    description: "Deduplicate date folders and sort them newest first.",
    type: "browser-opt:sort-date-groups",
    runningLabel: "Merging and sorting date folders",
  },
];

function normalize(text) {
  return (text || "").toLowerCase();
}

function resultText(tab) {
  return `${tab.title || ""} ${tab.url || ""}`;
}

function actionText(action) {
  return `${action.title} ${action.description}`;
}

function archivedTabText(tab) {
  return `${tab.title || ""} ${tab.url || ""} ${tab.archiveDate || ""}`;
}

function createTabResult(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tab-result${tab.active ? " active" : ""}`;
  button.title = tab.url || tab.title || "Untitled tab";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", tab.active ? "true" : "false");

  const icon = document.createElement("img");
  icon.className = "tab-icon";
  icon.alt = "";
  if (tab.favIconUrl) {
    icon.src = tab.favIconUrl;
  }

  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || "Untitled tab";

  const url = document.createElement("div");
  url.className = "tab-url";
  url.textContent = tab.url || "";

  text.append(title, url);
  button.append(icon, text);
  button.addEventListener("click", () => focusTab(tab));

  return button;
}

function createActionResult(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-result";
  button.setAttribute("role", "option");

  const title = document.createElement("div");
  title.className = "action-title";
  title.textContent = action.title;

  const description = document.createElement("div");
  description.className = "action-description";
  description.textContent = action.description;

  button.append(title, description);
  button.addEventListener("click", () => runAction(action));

  return button;
}

function createArchiveResult(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "archive-result";
  button.title = tab.url || tab.title || "Archived tab";
  button.setAttribute("role", "option");

  const icon = document.createElement("div");
  icon.className = "archive-icon";
  icon.textContent = "A";

  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "archive-title";
  title.textContent = tab.title || "Untitled archived tab";

  const url = document.createElement("div");
  url.className = "archive-url";
  url.textContent = tab.url || "";

  const date = document.createElement("div");
  date.className = "archive-date";
  date.textContent = tab.archiveDate ? `Archived ${tab.archiveDate}` : "Archived tab";

  text.append(title, url, date);
  button.append(icon, text);
  button.addEventListener("click", () => openArchivedTab(tab));

  return button;
}

function renderTabs() {
  const query = normalize(searchInput.value.trim());
  const matchingTabs = tabs
    .filter(tab => !query || normalize(resultText(tab)).includes(query))
    .sort((a, b) => Number(b.active) - Number(a.active))
    .slice(0, 50);
  renderedTabs = matchingTabs;

  tabResults.textContent = "";
  if (!matchingTabs.length) {
    const empty = document.createElement("div");
    empty.id = "tab-empty";
    empty.textContent = tabs.length ? "No matching tabs." : "No open tabs found.";
    tabResults.append(empty);
    return;
  }

  for (const tab of matchingTabs) {
    tabResults.append(createTabResult(tab));
  }
}

function renderActions() {
  const query = normalize(actionInput.value.trim());
  const matchingActions = actions.filter(action => !query || normalize(actionText(action)).includes(query));
  renderedActions = matchingActions;

  actionResults.textContent = "";
  if (!matchingActions.length) {
    const empty = document.createElement("div");
    empty.id = "action-empty";
    empty.textContent = "No matching actions.";
    actionResults.append(empty);
    return;
  }

  for (const action of matchingActions) {
    actionResults.append(createActionResult(action));
  }
}

function renderArchivedTabs() {
  archiveResults.textContent = "";
  if (!renderedArchivedTabs.length) {
    const empty = document.createElement("div");
    empty.id = "archive-empty";
    empty.textContent = archiveInput.value.trim() ? "No matching archived tabs." : "No archived tabs found.";
    archiveResults.append(empty);
    return;
  }

  for (const tab of renderedArchivedTabs) {
    archiveResults.append(createArchiveResult(tab));
  }
}

function resultButtons(container) {
  return Array.from(container.querySelectorAll("button[role='option']"));
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
  const nextIndex = Math.min(
    buttons.length - 1,
    Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + offset)
  );

  buttons[nextIndex].focus();
  buttons[nextIndex].scrollIntoView({ block: "nearest" });
}

async function loadTabs() {
  tabs = await browser.tabs.query({});
  renderTabs();
}

async function loadArchivedTabs() {
  const query = archiveInput.value.trim();
  const result = await browser.runtime.sendMessage({
    type: "browser-opt:archived-tabs",
    query,
    limit: 50,
  });
  renderedArchivedTabs = (result && result.tabs) || [];
  if (query) {
    const normalizedQuery = normalize(query);
    renderedArchivedTabs = renderedArchivedTabs.filter(tab => normalize(archivedTabText(tab)).includes(normalizedQuery));
  }
  renderArchivedTabs();
}

async function focusTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
  window.close();
}

async function openArchivedTab(tab) {
  if (!tab.url) return;
  status.textContent = "Opening archived tab...";
  try {
    await browser.runtime.sendMessage({ type: "browser-opt:open-url", url: tab.url });
    window.close();
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

async function runAction(action) {
  if (action.mode) {
    location.href = `popup.html?mode=${encodeURIComponent(action.mode)}`;
    return;
  }

  const payload = { type: action.type };
  if (action.promptTitle) {
    const title = window.prompt("Name the Tree Style Tab folder", "Selected Tabs");
    if (!title || !title.trim()) {
      status.textContent = "Cancelled.";
      return;
    }
    payload.title = title.trim();
  }
  if (action.promptRenameTitle) {
    const title = window.prompt("Rename active tab", "");
    if (!title || !title.trim()) {
      status.textContent = "Cancelled.";
      return;
    }
    payload.title = title.trim();
  }

  status.textContent = `${action.runningLabel}...`;
  try {
    const result = await browser.runtime.sendMessage(payload);
    status.textContent = result && result.message ? result.message : "Done.";
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

function handleSearchKeydown(event, renderedItems, runFirstItem) {
  if (event.key === "Enter" && renderedItems.length) {
    event.preventDefault();
    runFirstItem(renderedItems[0]);
  }
}

function handleResultsKeydown(event, container) {
  if (event.key === "j" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, 1);
    return;
  }

  if (event.key === "k" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, -1);
    return;
  }

  if (event.key === "d" && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, visibleStep(container, resultButtons(container)));
    return;
  }

  if (event.key === "u" && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusResult(container, -visibleStep(container, resultButtons(container)));
  }
}

if (mode === "actions") {
  tabPanel.classList.add("hidden");
  actionPanel.classList.remove("hidden");
  archivePanel.classList.add("hidden");
  renderActions();
  actionInput.addEventListener("input", renderActions);
  actionInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedActions, runAction));
  actionResults.addEventListener("keydown", event => handleResultsKeydown(event, actionResults));
  actionInput.focus();
} else if (mode === "history") {
  tabPanel.classList.add("hidden");
  actionPanel.classList.add("hidden");
  archivePanel.classList.remove("hidden");
  archiveInput.addEventListener("input", () => {
    clearTimeout(archiveSearchTimer);
    archiveSearchTimer = setTimeout(() => {
      loadArchivedTabs().catch(error => {
        renderedArchivedTabs = [];
        renderArchivedTabs();
        status.textContent = error.message || String(error);
      });
    }, 120);
  });
  archiveInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedArchivedTabs, openArchivedTab));
  archiveResults.addEventListener("keydown", event => handleResultsKeydown(event, archiveResults));
  loadArchivedTabs().catch(error => {
    renderedArchivedTabs = [];
    renderArchivedTabs();
    status.textContent = error.message || String(error);
  });
  archiveInput.focus();
} else {
  tabPanel.classList.remove("hidden");
  actionPanel.classList.add("hidden");
  archivePanel.classList.add("hidden");
  searchInput.addEventListener("input", renderTabs);
  searchInput.addEventListener("keydown", event => handleSearchKeydown(event, renderedTabs, focusTab));
  tabResults.addEventListener("keydown", event => handleResultsKeydown(event, tabResults));
  loadTabs().catch(error => {
    tabResults.textContent = "";
    const empty = document.createElement("div");
    empty.id = "tab-empty";
    empty.textContent = error.message || String(error);
    tabResults.append(empty);
  });
  searchInput.focus();
}
