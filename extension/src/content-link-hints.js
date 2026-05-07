document.addEventListener(
  "click",
  event => {
    const link = event.target && event.target.closest && event.target.closest("a[href]");
    if (!link) return;

    const targetUrl = new URL(link.getAttribute("href"), document.location.href).href;
    if (!/^https?:/.test(targetUrl)) return;

    browser.runtime.sendMessage({
      type: "browser-opt:link-click",
      sourceUrl: document.location.href,
      targetUrl,
      clickedAt: new Date().toISOString(),
    });
  },
  { capture: true }
);
