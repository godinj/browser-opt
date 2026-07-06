const HOST_NAME = "browser_opt";
const TST_ID = "treestyletab@piro.sakura.ne.jp";
const TERMINAL_URL = "http://127.0.0.1:7681/";
const TERMINAL_MATCH_URL = "http://127.0.0.1:7681/*";

let port = null;
let reconnectTimer = null;
let nextRequestId = 1;
let suppressTSTMoveFixups = 0;
let pollingOpenRequests = false;
let popupWindowId = null;
let lastPopupSource = {};
const tabsBeingCopiedToToday = new Set();
const newTabsPendingToday = new Set();
const pendingDateGroupCreations = new Map();
const pendingNativeRequests = new Map();
const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 520;

function setStatus(text, color = "#666666") {
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    title,
    message,
  }).catch(() => {
    console.info(`${title}: ${message}`);
  });
}

function connectNative() {
  if (port) return port;

  try {
    port = browser.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(message => {
      const pending = pendingNativeRequests.get(message.requestId);
      if (!pending) return;
      pendingNativeRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.message || "Native host request failed"));
      }
    });
    port.onDisconnect.addListener(() => {
      for (const pending of pendingNativeRequests.values()) {
        pending.reject(new Error("Native host disconnected"));
      }
      pendingNativeRequests.clear();
      port = null;
      scheduleReconnect();
    });
    sendNative("hello", {
      extensionVersion: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    });
    snapshotTabs("connect");
  } catch (error) {
    console.error("Browser Opt native host connection failed", error);
    scheduleReconnect();
  }

  return port;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 5000);
}

function sendNative(type, payload = {}) {
  const nativePort = port || connectNative();
  if (!nativePort) return;

  try {
    nativePort.postMessage({
      v: 1,
      type,
      sentAt: new Date().toISOString(),
      payload,
    });
  } catch (error) {
    console.error("Browser Opt native message failed", error);
    port = null;
    scheduleReconnect();
  }
}

function sendNativeRequest(type, payload = {}) {
  const nativePort = port || connectNative();
  if (!nativePort) return Promise.reject(new Error("Native host unavailable"));

  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingNativeRequests.set(requestId, { resolve, reject });
    try {
      nativePort.postMessage({
        v: 1,
        type,
        requestId,
        sentAt: new Date().toISOString(),
        payload,
      });
    } catch (error) {
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

async function snapshotTabs(reason) {
  const tabs = await browser.tabs.query({});
  sendNative("tab_snapshot", {
    reason,
    capturedAt: new Date().toISOString(),
    tabs: tabs.map(tabPayload),
  });
}

function tabPayload(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    discarded: tab.discarded,
    position: tab.index,
    status: tab.status,
  };
}

function visitPayload(details, tab) {
  return {
    url: details.url,
    title: tab && tab.url === details.url ? tab.title : undefined,
    visitedAt: new Date(details.timeStamp || Date.now()).toISOString(),
    tabId: details.tabId,
    windowId: tab ? tab.windowId : undefined,
    transitionType: details.transitionType,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isDateTitle(title) {
  return /^\d{4}-\d{2}-\d{2}$/.test(title || "");
}

function todayDateTitle() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeUrlForMatch(input) {
  try {
    const url = new URL(input);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    return url.href;
  } catch (_) {
    return input;
  }
}

function isTSTGroupTab(item) {
  return Array.isArray(item.states) && item.states.includes("group-tab");
}

function isTSTFolder(item) {
  return isTSTGroupTab(item) || Boolean(item.tab && item.tab.url && item.tab.url.includes("/resources/group-tab.html"));
}

function collectDirectChildren(item) {
  return Array.isArray(item.children) ? item.children.map(child => child.id) : [];
}

function collectDescendantTabIds(item) {
  const tabIds = [];
  const visit = child => {
    tabIds.push(child.id);
    for (const grandchild of child.children || []) {
      visit(grandchild);
    }
  };
  for (const child of item.children || []) {
    visit(child);
  }
  return tabIds;
}

async function getTSTItemsByWindow(windowId) {
  const treeItems = await browser.runtime.sendMessage(TST_ID, {
    type: "get-light-tree",
    window: windowId,
    tabs: "*",
  });
  const tabs = await browser.tabs.query({ windowId });
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const itemsById = new Map();

  const visit = item => {
    if (!item || itemsById.has(item.id)) return;
    itemsById.set(item.id, {
      ...item,
      tab: tabsById.get(item.id),
    });
    for (const child of item.children || []) {
      visit(child);
    }
  };

  for (const item of treeItems || []) {
    visit(item);
  }

  return Array.from(itemsById.values());
}

async function getTSTSelectedTabIds(windowId) {
  const treeItems = await browser.runtime.sendMessage(TST_ID, {
    type: "get-light-tree",
    window: windowId,
    tabs: "multiselected",
  });
  const selectedIds = [];
  const visit = item => {
    if (!item || item.id === undefined) return;
    selectedIds.push(item.id);
    for (const child of item.children || []) {
      visit(child);
    }
  };
  for (const item of treeItems || []) {
    visit(item);
  }
  return [...new Set(selectedIds)];
}

async function detachTabFromTree(tabId) {
  try {
    await browser.runtime.sendMessage(TST_ID, {
      type: "detach",
      tab: tabId,
    });
  } catch (error) {
    console.warn(`Browser Opt could not detach tab ${tabId}`, error);
  }
}

async function attachTabToParent(childId, parentId) {
  await browser.runtime.sendMessage(TST_ID, {
    type: "attach",
    child: childId,
    parent: parentId,
  });
}

async function findDateGroup(windowId, title) {
  const items = await getTSTItemsByWindow(windowId);
  return items.find(item => isTSTGroupTab(item) && item.tab && item.tab.title === title);
}

async function findDateGroupForTab(tab) {
  if (!tab || tab.id === undefined || tab.windowId === undefined) return null;
  const items = await getTSTItemsByWindow(tab.windowId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  const item = itemsById.get(tab.id);
  if (!item) return null;
  if (isTSTGroupTab(item) && isDateTitle(item.tab && item.tab.title)) return item;

  return [...(item.ancestorTabIds || [])]
    .reverse()
    .map(tabId => itemsById.get(tabId))
    .find(ancestor => ancestor && isTSTGroupTab(ancestor) && isDateTitle(ancestor.tab && ancestor.tab.title)) || null;
}

async function findOrCreateDateGroupForTab(tab, title) {
  const existingGroup = await findDateGroup(tab.windowId, title);
  if (existingGroup) return existingGroup;

  const creationKey = `${tab.windowId}:${title}`;
  if (!pendingDateGroupCreations.has(creationKey)) {
    const creation = (async () => {
      const existingGroupAfterWait = await findDateGroup(tab.windowId, title);
      if (existingGroupAfterWait) return existingGroupAfterWait;

      const createdGroup = await browser.runtime.sendMessage(TST_ID, {
        type: "group-tabs",
        title,
        tabs: [tab.id],
        temporary: false,
        temporaryAggressive: false,
      });
      const dateGroup = createdGroup || await findDateGroup(tab.windowId, title);
      if (dateGroup) await moveTreeToStartAsRoot(dateGroup.id);
      return dateGroup;
    })().finally(() => {
      pendingDateGroupCreations.delete(creationKey);
    });
    pendingDateGroupCreations.set(creationKey, creation);
  }

  return pendingDateGroupCreations.get(creationKey);
}

async function ensureTabUnderToday(tab) {
  if (!tab || tab.id === undefined || tab.windowId === undefined || isTSTGroupTabUrl(tab.url) || isPopupTab(tab)) {
    return null;
  }

  const today = todayDateTitle();
  await registerToTST();
  const todayGroup = await findOrCreateDateGroupForTab(tab, today);
  if (!todayGroup) return null;

  const currentGroup = await findDateGroupForTab(tab).catch(() => null);
  if (currentGroup && currentGroup.id === todayGroup.id) return todayGroup;

  await attachTabToParent(tab.id, todayGroup.id);
  return todayGroup;
}

async function ensureTabUnderTodayAndVerify(tab) {
  const todayGroup = await ensureTabUnderToday(tab);
  if (!todayGroup) return null;

  await sleep(500);
  const currentGroup = await findDateGroupForTab(tab);
  if (!currentGroup || !currentGroup.tab || currentGroup.tab.title !== todayDateTitle()) {
    throw new Error(`Tab ${tab.id} was not placed in today's TST date group`);
  }
  return currentGroup;
}

async function copyTabToToday(tab, { active = tab && tab.active } = {}) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url) || tabsBeingCopiedToToday.has(tab.id)) return false;

  tabsBeingCopiedToToday.add(tab.id);
  try {
    const currentGroup = await findDateGroupForTab(tab);
    const today = todayDateTitle();
    if (!currentGroup || !currentGroup.tab || currentGroup.tab.title === today) return false;

    const copiedTab = await browser.tabs.create({
      url: tab.url,
      windowId: tab.windowId,
      index: tab.index + 1,
      active,
    });
    await ensureTabUnderToday(copiedTab);
    return true;
  } finally {
    tabsBeingCopiedToToday.delete(tab.id);
  }
}

async function placeCompletedTabForToday(tab) {
  if (!tab || tab.id === undefined) return;

  if (newTabsPendingToday.has(tab.id)) {
    try {
      await placeTabUnderTodayWithRetries(tab.id, tab);
    } finally {
      newTabsPendingToday.delete(tab.id);
    }
    return;
  }
  await placeTabUnderTodayWithRetries(tab.id, tab);
}

async function placeTabUnderTodayWithRetries(tabId, initialTab = null) {
  const delays = [0, 100, 250, 500, 1000, 1500];
  let lastError = null;

  for (const delay of delays) {
    if (delay) await sleep(delay);
    const tab = delay === 0 && initialTab ? initialTab : await browser.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return;
    }

    try {
      await ensureTabUnderTodayAndVerify(tab);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Timed out placing tab ${tabId} in today's TST date group`);
}

async function placeNewTabUnderToday(tabId) {
  newTabsPendingToday.add(tabId);
  try {
    await placeTabUnderTodayWithRetries(tabId);
  } finally {
    newTabsPendingToday.delete(tabId);
  }
}

async function focusTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
}

async function focusTerminalTab(tab) {
  await focusTab(tab);
  await browser.tabs.sendMessage(tab.id, { type: "browser-opt:focus-ttyd" }).catch(() => {});
}

function isPopupTab(tab) {
  return Boolean(tab && tab.url && tab.url.startsWith(browser.runtime.getURL("popup.html")));
}

async function popupWindowFromId(windowId) {
  if (!windowId) return null;
  const popupWindow = await browser.windows.get(windowId, { populate: true }).catch(() => null);
  if (!popupWindow || !popupWindow.tabs || !popupWindow.tabs.some(isPopupTab)) return null;
  return popupWindow;
}

async function findPopupWindow() {
  const rememberedWindow = await popupWindowFromId(popupWindowId);
  if (rememberedWindow) return rememberedWindow;

  const popupWindows = await browser.windows.getAll({ populate: true, windowTypes: ["popup"] });
  return popupWindows.find(window => window.tabs && window.tabs.some(isPopupTab)) || null;
}

async function activeTabInActionSource(source = {}) {
  if (source.tabId) {
    const tab = await browser.tabs.get(source.tabId).catch(() => null);
    if (tab) return tab;
  }

  if (source.windowId) {
    const [activeTab] = await browser.tabs.query({ active: true, windowId: source.windowId });
    if (activeTab) return activeTab;
  }

  const window = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
  const [activeTab] = await browser.tabs.query({ active: true, windowId: window.id });
  return activeTab;
}

async function openPopup(mode = "tabs") {
  const url = browser.runtime.getURL(`popup.html?mode=${encodeURIComponent(mode)}`);
  const currentWindow = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const [activeTab] = currentWindow
    ? await browser.tabs.query({ active: true, windowId: currentWindow.id }).catch(() => [])
    : [];
  lastPopupSource = {
    windowId: currentWindow && currentWindow.id,
    tabId: activeTab && activeTab.id,
  };

  const existingWindow = await findPopupWindow();
  if (existingWindow) {
    popupWindowId = existingWindow.id;
    const popupTab = existingWindow.tabs.find(isPopupTab);
    if (popupTab.url !== url) {
      await browser.tabs.update(popupTab.id, { url, active: true });
    }
    await browser.windows.update(existingWindow.id, { focused: true });
    return;
  }

  const createProperties = {
    url,
    type: "popup",
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    focused: true,
  };

  if (currentWindow) {
    createProperties.left = Math.round(currentWindow.left + (currentWindow.width - POPUP_WIDTH) / 2);
    createProperties.top = Math.round(currentWindow.top + (currentWindow.height - POPUP_HEIGHT) / 2);
  }

  const popupWindow = await browser.windows.create(createProperties);
  popupWindowId = popupWindow.id;
}

async function openTerminal() {
  const tabs = await browser.tabs.query({ url: TERMINAL_MATCH_URL });
  const existingTab = tabs[0];
  if (existingTab) {
    await focusTerminalTab(existingTab);
    return;
  }

  const currentWindow = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const createProperties = currentWindow ? { url: TERMINAL_URL, windowId: currentWindow.id } : { url: TERMINAL_URL };
  const tab = await browser.tabs.create(createProperties);
  await focusTerminalTab(tab);
}

async function openUrlUnderToday(url) {
  const normalizedUrl = normalizeUrlForMatch(url);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(tab => tab.url && normalizeUrlForMatch(tab.url) === normalizedUrl);
  if (existing) {
    if (await copyTabToToday(existing, { active: true })) {
      return "copied-under-today";
    }
    await focusTab(existing);
    return "focused";
  }

  const currentWindow = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const windowId = currentWindow && currentWindow.id;
  const createProperties = windowId ? { url, windowId } : { url };
  const today = todayDateTitle();

  let dateGroup = null;
  try {
    await registerToTST();
    dateGroup = windowId ? await findDateGroup(windowId, today) : null;
  } catch (error) {
    console.warn("Browser Opt could not inspect today's TST date group", error);
  }

  if (dateGroup) {
    const tab = await browser.tabs.create({
      ...createProperties,
      index: dateGroup.tab.index + 1,
      openerTabId: dateGroup.id,
      active: true,
    });
    try {
      await attachTabToParent(tab.id, dateGroup.id);
    } catch (error) {
      console.warn("Browser Opt could not attach tab to today's TST date group", error);
    }
    try {
      await moveTreeToStartAsRoot(dateGroup.id);
    } catch (error) {
      console.warn("Browser Opt could not restore today's TST date group position", error);
    }
    return "opened-under-existing-date";
  }

  const tab = await browser.tabs.create({ ...createProperties, active: true });
  try {
    await ensureTabUnderToday(tab);
  } catch (error) {
    console.warn("Browser Opt could not create today's TST date group", error);
    return "opened-without-date";
  }

  return "opened-under-new-date";
}

async function pollOpenRequests() {
  if (pollingOpenRequests) return;
  pollingOpenRequests = true;
  try {
    const { requests } = await sendNativeRequest("pending_open_requests");
    const handledIds = [];
    for (const request of requests || []) {
      if (!request || !request.id || !request.url) continue;
      await openUrlUnderToday(request.url);
      handledIds.push(request.id);
    }
    if (handledIds.length) {
      await sendNativeRequest("mark_open_requests_handled", { ids: handledIds });
      await snapshotTabs("open-request");
    }
  } catch (error) {
    console.warn("Browser Opt open request polling failed", error);
  } finally {
    pollingOpenRequests = false;
  }
}

async function moveTreeToStart(tabId) {
  await browser.runtime.sendMessage(TST_ID, {
    type: "move-to-start",
    tab: tabId,
  });
}

async function moveTreeToStartAsRoot(tabId) {
  await detachTabFromTree(tabId);
  await moveTreeToStart(tabId);
}

async function moveDateGroupToStart(windowId, title) {
  const dateGroup = await findDateGroup(windowId, title);
  if (dateGroup) {
    await moveTreeToStartAsRoot(dateGroup.id);
  }
}

async function moveTreeAfter(tabId, referenceTabId) {
  await browser.runtime.sendMessage(TST_ID, {
    type: "move-after",
    tab: tabId,
    referenceTabId,
    followChildren: true,
  });
}

async function suppressTSTMoveFixupsWhile(callback) {
  suppressTSTMoveFixups += 1;
  try {
    return await callback();
  } finally {
    await sleep(250);
    suppressTSTMoveFixups = Math.max(0, suppressTSTMoveFixups - 1);
  }
}

async function getLastAccessedDateByTabId() {
  const { groups } = await sendNativeRequest("firefox_last_accessed_tabs");
  const datesByUrl = new Map();
  for (const group of groups) {
    for (const sessionTab of group.tabs) {
      const dates = datesByUrl.get(sessionTab.url) || [];
      dates.push(group.date);
      datesByUrl.set(sessionTab.url, dates);
    }
  }

  const datesByTabId = new Map();
  const openTabs = await browser.tabs.query({});
  for (const tab of openTabs) {
    if (!tab.url || !/^https?:/.test(tab.url)) continue;
    const dates = datesByUrl.get(tab.url);
    const date = dates && dates.shift();
    if (date) {
      datesByTabId.set(tab.id, date);
    }
  }
  return datesByTabId;
}

function hasDateAncestor(item, itemsById) {
  for (const ancestorId of item.ancestorTabIds || []) {
    const ancestor = itemsById.get(ancestorId);
    if (ancestor && isDateTitle(ancestor.tab && ancestor.tab.title)) {
      return true;
    }
  }
  return false;
}

function hasNonDateAncestor(item, itemsById) {
  for (const ancestorId of item.ancestorTabIds || []) {
    const ancestor = itemsById.get(ancestorId);
    if (ancestor && !isDateTitle(ancestor.tab && ancestor.tab.title)) {
      return true;
    }
  }
  return false;
}

async function cleanupDateGroupsAndCategories() {
  setStatus("...", "#6f42c1");
  await registerToTST();
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  let promotedDateGroups = 0;
  let removedCategoryGroups = 0;

  for (const window of windows) {
    let items = await getTSTItemsByWindow(window.id);
    for (const item of items) {
      if (!isDateTitle(item.tab && item.tab.title)) continue;
      if (!item.ancestorTabIds || !item.ancestorTabIds.length) continue;
      await detachTabFromTree(item.id);
      await browser.tabs.move(item.id, { windowId: window.id, index: -1 });
      promotedDateGroups += 1;
    }

    await sleep(100);
    items = await getTSTItemsByWindow(window.id);
    const categoryItems = items.filter(item => {
      const title = item.tab && item.tab.title;
      return isTSTGroupTab(item) && !isDateTitle(title);
    });

    for (const category of categoryItems) {
      for (const childId of collectDirectChildren(category)) {
        await detachTabFromTree(childId);
      }
    }

    await sleep(100);
    for (const category of categoryItems) {
      try {
        await browser.tabs.remove(category.id);
        removedCategoryGroups += 1;
      } catch (error) {
        console.warn(`Browser Opt could not remove category tab ${category.id}`, error);
      }
    }
  }

  setStatus(String(promotedDateGroups), "#008000");
  const message = `Moved ${promotedDateGroups} date groups out and removed ${removedCategoryGroups} category folders.`;
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
  return { message };
}

function findFolderForTab(tab, items, itemsById) {
  const activeItem = itemsById.get(tab.id);
  if (!activeItem) return null;

  let folder = isTSTFolder(activeItem) ? activeItem : null;
  if (!folder && activeItem.ancestorTabIds && activeItem.ancestorTabIds.length) {
    folder = [...activeItem.ancestorTabIds]
      .reverse()
      .map(tabId => itemsById.get(tabId))
      .find(item => item && isTSTFolder(item));
  }
  if (!folder) {
    folder = items
      .filter(item => isTSTFolder(item) && collectDescendantTabIds(item).includes(tab.id))
      .sort((a, b) => (b.ancestorTabIds || []).length - (a.ancestorTabIds || []).length)[0];
  }
  if (!folder) {
    folder = items
      .filter(item => isTSTFolder(item) && item.tab && item.tab.index < tab.index)
      .sort((a, b) => b.tab.index - a.tab.index)[0];
  }
  return folder || null;
}

async function archiveCurrentFolder({ closeFolder = false, source = {} } = {}) {
  setStatus("...", "#6f42c1");
  await registerToTST();

  const activeTab = await activeTabInActionSource(source);
  if (!activeTab) {
    throw new Error("No active tab found.");
  }

  const selectedTabs = (await browser.tabs.query({ highlighted: true, windowId: activeTab.windowId }))
    .filter(tab => tab && tab.id !== undefined);
  const tabsToResolve = selectedTabs.length > 1 ? selectedTabs : [activeTab];
  const items = await getTSTItemsByWindow(activeTab.windowId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  const activeItem = itemsById.get(activeTab.id);
  if (!activeItem) {
    throw new Error("Active tab is not visible to Tree Style Tab.");
  }

  const folders = [];
  const folderIds = new Set();
  for (const tab of tabsToResolve) {
    const folder = findFolderForTab(tab, items, itemsById);
    if (!folder || folderIds.has(folder.id)) continue;
    folderIds.add(folder.id);
    folders.push(folder);
  }

  const selectedFolderIds = new Set(folders.map(folder => folder.id));
  const archiveFolders = folders.filter(folder =>
    !(folder.ancestorTabIds || []).some(tabId => selectedFolderIds.has(tabId))
  );

  if (!archiveFolders.length) {
    const activeDetails = [
      `tab=${activeTab.id}`,
      `index=${activeTab.index}`,
      `title=${activeTab.title || ""}`,
      `ancestors=${(activeItem.ancestorTabIds || []).join(",") || "none"}`,
      `states=${(activeItem.states || []).join(",") || "none"}`,
    ].join(" ");
    throw new Error(`Active tab is not inside a Tree Style Tab folder. ${activeDetails}`);
  }

  let archivedTabs = 0;
  const archivedFolders = [];
  const tabIdsToClose = new Set();
  for (const folder of archiveFolders) {
    const descendantIds = collectDescendantTabIds(folder);
    const tabsToArchive = descendantIds
      .map(tabId => itemsById.get(tabId) && itemsById.get(tabId).tab)
      .filter(tab => tab && tab.url && /^https?:/.test(tab.url))
      .map(tabPayload);
    if (!tabsToArchive.length) continue;

    const archiveDate = isDateTitle(folder.tab && folder.tab.title) ? folder.tab.title : todayDateTitle();
    const result = await sendNativeRequest("archive_tabs", {
      date: archiveDate,
      tabs: tabsToArchive,
    });
    archivedTabs += tabsToArchive.length;
    archivedFolders.push({ folder, date: result.date });

    if (closeFolder) {
      for (const tabId of [...descendantIds, folder.id]) {
        tabIdsToClose.add(tabId);
      }
    }
  }

  if (!archivedTabs) {
    throw new Error(archiveFolders.length === 1
      ? "Folder does not contain any archiveable HTTP tabs."
      : "Selected folders do not contain any archiveable HTTP tabs.");
  }

  if (closeFolder) {
    for (const tabId of tabIdsToClose) {
      await browser.tabs.remove(tabId).catch(error => {
        console.warn(`Browser Opt could not close tab ${tabId}`, error);
      });
    }
    await sleep(150);
    const remainingTabIds = (
      await Promise.all([...tabIdsToClose].map(tabId => browser.tabs.get(tabId).then(tab => tab.id).catch(() => null)))
    ).filter(Boolean);
    if (remainingTabIds.length) {
      await browser.tabs.remove(remainingTabIds);
    }
    await snapshotTabs("archive-folder-close");
  }

  const message = archivedFolders.length === 1
    ? (closeFolder
      ? `Archived and closed ${archivedTabs} tabs from "${archivedFolders[0].folder.tab.title || "folder"}" into ${archivedFolders[0].date}.`
      : `Archived ${archivedTabs} tabs from "${archivedFolders[0].folder.tab.title || "folder"}" into ${archivedFolders[0].date}.`)
    : (closeFolder
      ? `Archived and closed ${archivedTabs} tabs from ${archivedFolders.length} folders.`
      : `Archived ${archivedTabs} tabs from ${archivedFolders.length} folders.`);
  setStatus(String(archivedTabs), "#008000");
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
  return { message };
}

async function promptForTSTFolderTitle(tab, defaultTitle = "Selected Tabs") {
  if (typeof window.prompt === "function") {
    const title = window.prompt("Name the Tree Style Tab folder", defaultTitle);
    return title && title.trim() ? title.trim() : null;
  }

  const results = await browser.tabs.executeScript(tab.id, {
    code: `window.prompt(${JSON.stringify("Name the Tree Style Tab folder")}, ${JSON.stringify(defaultTitle)})`,
  });
  const title = results && results[0];
  return title && title.trim() ? title.trim() : null;
}

async function promptForTabTitle(tab) {
  const defaultTitle = tab && tab.title ? tab.title : "";
  if (typeof window.prompt === "function") {
    const title = window.prompt("Rename active tab", defaultTitle);
    return title && title.trim() ? title.trim() : null;
  }

  const results = await browser.tabs.executeScript(tab.id, {
    code: `window.prompt(${JSON.stringify("Rename active tab")}, ${JSON.stringify(defaultTitle)})`,
  });
  const title = results && results[0];
  return title && title.trim() ? title.trim() : null;
}

function isTSTGroupTabUrl(url) {
  return Boolean(url && url.includes("/resources/group-tab.html"));
}

function canInjectTabTitleScript(tab) {
  return Boolean(tab && tab.url && /^https?:/.test(tab.url));
}

async function renameActiveTab({ source = {}, title } = {}) {
  setStatus("...", "#6f42c1");
  const activeTab = await activeTabInActionSource(source);
  if (!activeTab) {
    throw new Error("No active tab found.");
  }

  const newTitle = title && title.trim() ? title.trim() : await promptForTabTitle(activeTab);
  if (!newTitle) {
    const message = "Cancelled.";
    setStatus("", "#666666");
    return { message };
  }

  if (isTSTGroupTabUrl(activeTab.url)) {
    const url = new URL(activeTab.url);
    url.searchParams.set("title", newTitle);
    await browser.tabs.update(activeTab.id, { url: url.href });
  } else if (canInjectTabTitleScript(activeTab)) {
    await browser.tabs.executeScript(activeTab.id, {
      code: `document.title = ${JSON.stringify(newTitle)}; true;`,
    });
  } else {
    throw new Error("This tab cannot be renamed. Firefox only allows title overrides on regular HTTP(S) pages; Tree Style Tab folder tabs can be renamed directly.");
  }

  setStatus("1", "#008000");
  const message = `Renamed active tab to "${newTitle}".`;
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
  await snapshotTabs("rename-active-tab");
  return { message };
}

async function groupSelectedTabsIntoTSTFolder({ source = {}, title } = {}) {
  setStatus("...", "#6f42c1");
  await registerToTST();

  const activeTab = await activeTabInActionSource(source);
  if (!activeTab) {
    throw new Error("No active tab found.");
  }

  const folderTitle = title && title.trim() ? title.trim() : await promptForTSTFolderTitle(activeTab);
  if (!folderTitle) {
    const message = "Cancelled.";
    setStatus("", "#666666");
    return { message };
  }

  const selectedTabs = (await browser.tabs.query({ highlighted: true, windowId: activeTab.windowId }))
    .filter(tab => tab && tab.id !== undefined)
    .sort((a, b) => a.index - b.index);
  const tstSelectedTabIds = await getTSTSelectedTabIds(activeTab.windowId).catch(error => {
    console.warn("Browser Opt could not read TST selected tabs", error);
    return [];
  });
  const useTSTSelectionAlias = tstSelectedTabIds.length < 2 && selectedTabs.length < 2;
  const tabsToGroup = tstSelectedTabIds.length > 1
    ? tstSelectedTabIds
    : (selectedTabs.length > 1 ? selectedTabs.map(tab => tab.id) : ["multiselected"]);
  const parentTab = await browser.runtime.sendMessage(TST_ID, {
    type: "group-tabs",
    title: folderTitle,
    window: activeTab.windowId,
    tabs: tabsToGroup,
    temporary: false,
    temporaryAggressive: false,
  });
  const groupedCount = useTSTSelectionAlias ? "TST" : tabsToGroup.length;

  setStatus(String(parentTab && parentTab.id ? 1 : groupedCount), "#008000");
  const message = useTSTSelectionAlias
    ? `Grouped selected Tree Style Tab tabs into "${folderTitle}".`
    : `Grouped ${tabsToGroup.length} selected ${tabsToGroup.length === 1 ? "tab" : "tabs"} into "${folderTitle}".`;
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
  await snapshotTabs("group-selected-tabs");
  return { message };
}

async function sortDateGroupsNewestFirst() {
  setStatus("...", "#6f42c1");
  await registerToTST();
  const datesByTabId = await getLastAccessedDateByTabId();
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  let sortedDateGroups = 0;
  let mergedDateGroups = 0;
  let movedTrees = 0;

  await suppressTSTMoveFixupsWhile(async () => {
    for (const window of windows) {
      let items = await getTSTItemsByWindow(window.id);
      const dateGroupsByTitle = new Map();

      for (const item of items) {
        const title = item.tab && item.tab.title;
        if (!isTSTGroupTab(item) || !isDateTitle(title)) continue;
        const dateGroups = dateGroupsByTitle.get(title) || [];
        dateGroups.push(item);
        dateGroupsByTitle.set(title, dateGroups);
      }

      for (const dateGroups of dateGroupsByTitle.values()) {
        dateGroups.sort((a, b) => a.tab.index - b.tab.index);
        const keeper = dateGroups.find(group => !group.ancestorTabIds || !group.ancestorTabIds.length) || dateGroups[0];
        if (keeper.ancestorTabIds && keeper.ancestorTabIds.length) {
          await detachTabFromTree(keeper.id);
        }

        for (const duplicate of dateGroups) {
          if (duplicate.id === keeper.id) continue;
          for (const childId of collectDirectChildren(duplicate)) {
            await attachTabToParent(childId, keeper.id);
          }
          await browser.tabs.remove(duplicate.id);
          mergedDateGroups += 1;
        }
      }

      await sleep(100);
      items = await getTSTItemsByWindow(window.id);
      let dateGroups = items
        .filter(item => isTSTGroupTab(item) && isDateTitle(item.tab && item.tab.title))
        .sort((a, b) => b.tab.title.localeCompare(a.tab.title));

      for (const group of dateGroups) {
        if (group.ancestorTabIds && group.ancestorTabIds.length) {
          await detachTabFromTree(group.id);
        }
      }

      await sleep(100);
      items = await getTSTItemsByWindow(window.id);
      dateGroups = items
        .filter(item => isTSTGroupTab(item) && isDateTitle(item.tab && item.tab.title))
        .sort((a, b) => b.tab.title.localeCompare(a.tab.title));

      if (dateGroups.length) {
        await moveTreeToStart(dateGroups[0].id);
        sortedDateGroups += 1;
      }

      for (let index = 1; index < dateGroups.length; index += 1) {
        await moveTreeAfter(dateGroups[index].id, dateGroups[index - 1].id);
        sortedDateGroups += 1;
      }

      await sleep(100);
      items = await getTSTItemsByWindow(window.id);
      dateGroups = items
        .filter(item => isTSTGroupTab(item) && isDateTitle(item.tab && item.tab.title));

      for (const group of dateGroups) {
        if (group.ancestorTabIds && group.ancestorTabIds.length) {
          await detachTabFromTree(group.id);
        }
      }

      await sleep(100);
      items = await getTSTItemsByWindow(window.id);
      const itemsById = new Map(items.map(item => [item.id, item]));
      const dateGroupByTitle = new Map(
        items
          .filter(item => isTSTGroupTab(item) && isDateTitle(item.tab && item.tab.title))
          .map(group => [group.tab.title, group])
      );

      for (const item of items) {
        if (isTSTGroupTab(item) || isDateTitle(item.tab && item.tab.title)) continue;
        if (hasDateAncestor(item, itemsById) || hasNonDateAncestor(item, itemsById)) continue;
        const date = datesByTabId.get(item.id);
        const dateGroup = dateGroupByTitle.get(date);
        if (!dateGroup) continue;
        await attachTabToParent(item.id, dateGroup.id);
        movedTrees += 1;
      }
    }
  });

  setStatus(String(sortedDateGroups), "#008000");
  const message = `Moved ${movedTrees} remaining trees, merged ${mergedDateGroups} duplicate date folders, and sorted ${sortedDateGroups} date folders newest first.`;
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
  return { message };
}

async function registerToTST() {
  try {
    await browser.runtime.sendMessage(TST_ID, {
      type: "register-self",
      name: browser.runtime.getManifest().name,
      listeningTypes: ["ready", "permissions-changed", "try-fixup-tree-on-tab-moved"],
      permissions: ["tabs"],
    });
  } catch (error) {
    console.warn("Tree Style Tab is not available", error);
  }
}

async function groupTabsByLastAccessedDate() {
  setStatus("...", "#6f42c1");
  await registerToTST();
  const { groups } = await sendNativeRequest("firefox_last_accessed_tabs");
  const tabsByUrl = new Map();
  const openTabs = await browser.tabs.query({});

  for (const tab of openTabs) {
    if (!tab.url || !/^https?:/.test(tab.url)) continue;
    const tabs = tabsByUrl.get(tab.url) || [];
    tabs.push(tab);
    tabsByUrl.set(tab.url, tabs);
  }

  let groupedTabs = 0;
  let groupCount = 0;
  for (const group of groups) {
    const tabIdsByWindow = new Map();
    for (const sessionTab of group.tabs) {
      const matches = tabsByUrl.get(sessionTab.url);
      const tab = matches && matches.shift();
      if (!tab) continue;
      const tabIds = tabIdsByWindow.get(tab.windowId) || [];
      tabIds.push(tab.id);
      tabIdsByWindow.set(tab.windowId, tabIds);
    }

    for (const tabIds of tabIdsByWindow.values()) {
      if (!tabIds.length) continue;
      await browser.runtime.sendMessage(TST_ID, {
        type: "group-tabs",
        title: group.date,
        tabs: tabIds,
        temporary: false,
        temporaryAggressive: false,
      });
      groupedTabs += tabIds.length;
      groupCount += 1;
    }
  }

  setStatus(String(groupCount), "#008000");
  notify("Browser Opt", `Grouped ${groupedTabs} tabs into ${groupCount} Tree Style Tab date groups.`);
  console.info(`Browser Opt grouped ${groupedTabs} tabs into ${groupCount} date groups`);
}

browser.runtime.onMessageExternal.addListener((message, sender) => {
  if (sender.id !== TST_ID) return;
  if (message && message.messages) {
    for (const oneMessage of message.messages) {
      if (oneMessage.type === "try-fixup-tree-on-tab-moved" && suppressTSTMoveFixups) {
        return Promise.resolve(true);
      }
    }
  }
  if (message && message.type === "try-fixup-tree-on-tab-moved" && suppressTSTMoveFixups) {
    return Promise.resolve(true);
  }
  if (message && (message.type === "ready" || message.type === "permissions-changed")) {
    registerToTST();
  }
  return undefined;
});

browser.runtime.onStartup.addListener(() => snapshotTabs("startup"));
browser.runtime.onInstalled.addListener(() => snapshotTabs("installed"));

browser.tabs.onCreated.addListener(tab => {
  snapshotTabs("tab-created");
  placeNewTabUnderToday(tab.id).catch(error => {
    console.warn("Browser Opt could not place new tab in today's TST date group", error);
  });
});
browser.tabs.onRemoved.addListener(() => snapshotTabs("tab-removed"));
browser.tabs.onMoved.addListener(() => snapshotTabs("tab-moved"));
browser.tabs.onActivated.addListener(() => snapshotTabs("tab-activated"));
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    snapshotTabs("tab-updated");
  }
  if (changeInfo.status === "complete" && tab.url && /^https?:/.test(tab.url)) {
    sendNative("visit", {
      url: tab.url,
      title: tab.title,
      visitedAt: new Date().toISOString(),
      tabId,
      windowId: tab.windowId,
      transitionType: "tab_complete",
    });
    placeCompletedTabForToday(tab).catch(error => {
      console.warn("Browser Opt could not place completed tab in today's TST date group", error);
    });
  }
});

browser.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0 || !/^https?:/.test(details.url)) return;
  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch (_) {
    tab = undefined;
  }
  sendNative("navigation_event", visitPayload(details, tab));
});

browser.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0 || !/^https?:/.test(details.url)) return;
  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch (_) {
    tab = undefined;
  }
  sendNative("navigation_event", visitPayload({ ...details, transitionType: "history_state" }, tab));
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (message.type === "browser-opt:link-click") {
    sendNative("link_click_hint", {
      sourceUrl: message.sourceUrl,
      targetUrl: message.targetUrl,
      clickedAt: message.clickedAt,
      tabId: sender.tab && sender.tab.id,
      windowId: sender.tab && sender.tab.windowId,
    });
    return undefined;
  }
  if (message.type === "browser-opt:group-by-date") {
    return groupTabsByLastAccessedDate().then(() => ({ message: "Grouped tabs by date." }));
  }
  if (message.type === "browser-opt:archived-tabs") {
    return sendNativeRequest("archived_tabs", {
      query: message.query || "",
      limit: message.limit || 50,
    });
  }
  if (message.type === "browser-opt:open-url") {
    return openUrlUnderToday(message.url).then(result => ({ result }));
  }
  if (message.type === "browser-opt:cleanup-date-groups") {
    return cleanupDateGroupsAndCategories();
  }
  if (message.type === "browser-opt:archive-current-folder") {
    return archiveCurrentFolder({ source: lastPopupSource });
  }
  if (message.type === "browser-opt:archive-and-close-current-folder") {
    return archiveCurrentFolder({ closeFolder: true, source: lastPopupSource });
  }
  if (message.type === "browser-opt:group-selected-tabs") {
    return groupSelectedTabsIntoTSTFolder({ source: lastPopupSource, title: message.title });
  }
  if (message.type === "browser-opt:rename-active-tab") {
    return renameActiveTab({ source: lastPopupSource, title: message.title });
  }
  if (message.type === "browser-opt:sort-date-groups") {
    return sortDateGroupsNewestFirst();
  }
  if (message.type === "browser-opt:open-terminal") {
    return openTerminal().then(() => ({ message: "Opened terminal." }));
  }
  return undefined;
});

browser.browserAction.onClicked.addListener(() => {
  openPopup("tabs").catch(error => {
    setStatus("!", "#d73a49");
    notify("Browser Opt failed", error.message || String(error));
    console.error("Browser Opt failed to open tab search popup", error);
  });
});

browser.commands.onCommand.addListener(command => {
  const modesByCommand = {
    "open-tab-search": "tabs",
    "open-action-search": "actions",
    "open-archived-tab-search": "history",
  };
  if (command === "open-terminal") {
    openTerminal().catch(error => {
      setStatus("!", "#d73a49");
      notify("Browser Opt failed", error.message || String(error));
      console.error("Browser Opt failed to open terminal", error);
    });
    return;
  }
  if (command === "group-selected-tabs") {
    groupSelectedTabsIntoTSTFolder().catch(error => {
      setStatus("!", "#d73a49");
      notify("Browser Opt failed", error.message || String(error));
      console.error("Browser Opt failed to group selected tabs", error);
    });
    return;
  }
  if (command === "rename-active-tab") {
    renameActiveTab().catch(error => {
      setStatus("!", "#d73a49");
      notify("Browser Opt failed", error.message || String(error));
      console.error("Browser Opt failed to rename active tab", error);
    });
    return;
  }
  const mode = modesByCommand[command];
  if (!mode) return;
  openPopup(mode).catch(error => {
    setStatus("!", "#d73a49");
    notify("Browser Opt failed", error.message || String(error));
    console.error("Browser Opt failed to open popup", error);
  });
});

browser.windows.onRemoved.addListener(windowId => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

registerToTST();
connectNative();
setInterval(pollOpenRequests, 1000);

// Auto-clear cookies when configured domains return specific status codes.
// Config stored in browser.storage.local under "cookieClearRules":
//   [{ domain: "example.com", statusCodes: [400] }]
const COOKIE_CLEAR_DEFAULTS = [
  { domain: "manufacture.prod.mes.kbobjects.com", statusCodes: [400] },
];

let cookieClearRules = [];

async function loadCookieClearRules() {
  const { cookieClearRules: stored } = await browser.storage.local.get("cookieClearRules");
  cookieClearRules = stored || COOKIE_CLEAR_DEFAULTS;
  if (!stored) {
    await browser.storage.local.set({ cookieClearRules });
  }
  registerCookieClearListener();
}

function registerCookieClearListener() {
  if (browser.webRequest.onHeadersReceived.hasListener(onCookieClearResponse)) {
    browser.webRequest.onHeadersReceived.removeListener(onCookieClearResponse);
  }
  const urls = cookieClearRules.map(r => `https://${r.domain}/*`);
  if (!urls.length) return;
  browser.webRequest.onHeadersReceived.addListener(
    onCookieClearResponse,
    { urls, types: ["main_frame"] },
    []
  );
}

async function onCookieClearResponse(details) {
  const url = new URL(details.url);
  const rule = cookieClearRules.find(r => r.domain === url.hostname);
  if (!rule || !rule.statusCodes.includes(details.statusCode)) return;
  const cookies = await browser.cookies.getAll({ domain: url.hostname });
  if (!cookies.length) return;
  for (const cookie of cookies) {
    await browser.cookies.remove({
      url: `${url.protocol}//${cookie.domain}${cookie.path}`,
      name: cookie.name,
    });
  }
  console.info(`Browser Opt cleared ${cookies.length} cookies for ${url.hostname} after ${details.statusCode} response`);
  browser.tabs.reload(details.tabId);
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.cookieClearRules) loadCookieClearRules();
});

loadCookieClearRules();
