const HOST_NAME = "browser_opt";
const TST_ID = "treestyletab@piro.sakura.ne.jp";

let port = null;
let reconnectTimer = null;
let nextRequestId = 1;
let suppressTSTMoveFixups = false;
let pollingOpenRequests = false;
let popupWindowId = null;
let lastPopupSource = {};
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

async function focusTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
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

async function openUrlUnderToday(url) {
  const normalizedUrl = normalizeUrlForMatch(url);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(tab => tab.url && normalizeUrlForMatch(tab.url) === normalizedUrl);
  if (existing) {
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
      await moveTreeToStart(dateGroup.id);
    } catch (error) {
      console.warn("Browser Opt could not restore today's TST date group position", error);
    }
    return "opened-under-existing-date";
  }

  const tab = await browser.tabs.create({ ...createProperties, active: true });
  try {
    await browser.runtime.sendMessage(TST_ID, {
      type: "group-tabs",
      title: today,
      tabs: [tab.id],
      temporary: false,
      temporaryAggressive: false,
    });
  } catch (error) {
    console.warn("Browser Opt could not create today's TST date group", error);
    return "opened-without-date";
  }

  if (windowId) {
    try {
      await moveDateGroupToStart(windowId, today);
    } catch (error) {
      console.warn("Browser Opt could not restore today's TST date group position", error);
    }
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

async function moveDateGroupToStart(windowId, title) {
  const dateGroup = await findDateGroup(windowId, title);
  if (dateGroup) {
    await moveTreeToStart(dateGroup.id);
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
  suppressTSTMoveFixups = true;
  try {
    return await callback();
  } finally {
    await sleep(250);
    suppressTSTMoveFixups = false;
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

async function archiveCurrentFolder({ closeFolder = false, source = {} } = {}) {
  setStatus("...", "#6f42c1");
  await registerToTST();

  const activeTab = await activeTabInActionSource(source);
  if (!activeTab) {
    throw new Error("No active tab found.");
  }

  const items = await getTSTItemsByWindow(activeTab.windowId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  const activeItem = itemsById.get(activeTab.id);
  if (!activeItem) {
    throw new Error("Active tab is not visible to Tree Style Tab.");
  }

  let folder = isTSTFolder(activeItem) ? activeItem : null;
  if (!folder && activeItem.ancestorTabIds && activeItem.ancestorTabIds.length) {
    folder = [...activeItem.ancestorTabIds]
      .reverse()
      .map(tabId => itemsById.get(tabId))
      .find(item => item && isTSTFolder(item));
  }
  if (!folder) {
    folder = items
      .filter(item => isTSTFolder(item) && collectDescendantTabIds(item).includes(activeTab.id))
      .sort((a, b) => (b.ancestorTabIds || []).length - (a.ancestorTabIds || []).length)[0];
  }
  if (!folder) {
    folder = items
      .filter(item => isTSTFolder(item) && item.tab && item.tab.index < activeTab.index)
      .sort((a, b) => b.tab.index - a.tab.index)[0];
  }
  if (!folder) {
    const activeDetails = [
      `tab=${activeTab.id}`,
      `index=${activeTab.index}`,
      `title=${activeTab.title || ""}`,
      `ancestors=${(activeItem.ancestorTabIds || []).join(",") || "none"}`,
      `states=${(activeItem.states || []).join(",") || "none"}`,
    ].join(" ");
    throw new Error(`Active tab is not inside a Tree Style Tab folder. ${activeDetails}`);
  }

  const descendantIds = collectDescendantTabIds(folder);
  const tabsToArchive = descendantIds
    .map(tabId => itemsById.get(tabId) && itemsById.get(tabId).tab)
    .filter(tab => tab && tab.url && /^https?:/.test(tab.url))
    .map(tabPayload);
  if (!tabsToArchive.length) {
    throw new Error("Folder does not contain any archiveable HTTP tabs.");
  }

  const archiveDate = isDateTitle(folder.tab && folder.tab.title) ? folder.tab.title : todayDateTitle();
  const result = await sendNativeRequest("archive_tabs", {
    date: archiveDate,
    tabs: tabsToArchive,
  });

  if (closeFolder) {
    const tabIdsToClose = [...descendantIds, folder.id];
    for (const tabId of tabIdsToClose) {
      await browser.tabs.remove(tabId).catch(error => {
        console.warn(`Browser Opt could not close tab ${tabId}`, error);
      });
    }
    await sleep(150);
    const remainingTabIds = (
      await Promise.all(tabIdsToClose.map(tabId => browser.tabs.get(tabId).then(tab => tab.id).catch(() => null)))
    ).filter(Boolean);
    if (remainingTabIds.length) {
      await browser.tabs.remove(remainingTabIds);
    }
    await snapshotTabs("archive-folder-close");
  }

  const message = closeFolder
    ? `Archived and closed ${tabsToArchive.length} tabs from "${folder.tab.title || "folder"}" into ${result.date}.`
    : `Archived ${tabsToArchive.length} tabs from "${folder.tab.title || "folder"}" into ${result.date}.`;
  setStatus(String(tabsToArchive.length), "#008000");
  notify("Browser Opt", message);
  console.info(`Browser Opt ${message}`);
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

browser.tabs.onCreated.addListener(() => snapshotTabs("tab-created"));
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
  if (!message || message.type !== "browser-opt:link-click") return;
  sendNative("link_click_hint", {
    sourceUrl: message.sourceUrl,
    targetUrl: message.targetUrl,
    clickedAt: message.clickedAt,
    tabId: sender.tab && sender.tab.id,
    windowId: sender.tab && sender.tab.windowId,
  });
});

browser.runtime.onMessage.addListener(message => {
  if (!message || message.type === "browser-opt:link-click") return undefined;
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
  if (message.type === "browser-opt:sort-date-groups") {
    return sortDateGroupsNewestFirst();
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
  };
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
