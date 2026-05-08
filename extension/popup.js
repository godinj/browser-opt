const status = document.getElementById("status");
const searchInput = document.getElementById("tab-search");
const tabResults = document.getElementById("tab-results");
let tabs = [];
let renderedTabs = [];

function normalize(text) {
  return (text || "").toLowerCase();
}

function resultText(tab) {
  return `${tab.title || ""} ${tab.url || ""}`;
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

async function loadTabs() {
  tabs = await browser.tabs.query({});
  renderTabs();
}

async function focusTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
  window.close();
}

async function run(action, label) {
  status.textContent = `${label}...`;
  try {
    const result = await browser.runtime.sendMessage({ type: action });
    status.textContent = result && result.message ? result.message : "Done.";
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

document.getElementById("group").addEventListener("click", () => {
  run("browser-opt:group-by-date", "Grouping tabs");
});

document.getElementById("cleanup").addEventListener("click", () => {
  run("browser-opt:cleanup-date-groups", "Cleaning up TST folders");
});

document.getElementById("sort").addEventListener("click", () => {
  run("browser-opt:sort-date-groups", "Merging and sorting date folders");
});

searchInput.addEventListener("input", renderTabs);
searchInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && renderedTabs.length) {
    event.preventDefault();
    focusTab(renderedTabs[0]);
  }
});
loadTabs().catch(error => {
  tabResults.textContent = "";
  const empty = document.createElement("div");
  empty.id = "tab-empty";
  empty.textContent = error.message || String(error);
  tabResults.append(empty);
});
searchInput.focus();
