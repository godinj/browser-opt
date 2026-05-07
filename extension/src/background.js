const HOST_NAME = "browser_opt";

let port = null;
let reconnectTimer = null;

function connectNative() {
  if (port) return port;

  try {
    port = browser.runtime.connectNative(HOST_NAME);
    port.onDisconnect.addListener(() => {
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

connectNative();
