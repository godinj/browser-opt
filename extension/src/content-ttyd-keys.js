if (location.hostname === "127.0.0.1" && location.port === "7681") {
  function ttydTerm() {
    const pageWindow = window.wrappedJSObject || window;
    return pageWindow.term;
  }

  function focusTtydTerminal(attempts = 20) {
    const term = ttydTerm();
    if (term && typeof term.focus === "function") {
      term.focus();
      return term;
    }

    if (attempts > 0) {
      setTimeout(() => focusTtydTerminal(attempts - 1), 50);
    }
    return null;
  }

  function sendEscapeToTtyd() {
    const term = focusTtydTerminal();
    if (term && typeof term.input === "function") {
      term.input("\x1b");
    }
  }

  window.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      event.stopImmediatePropagation();
      sendEscapeToTtyd();
    },
    { capture: true }
  );

  browser.runtime.onMessage.addListener(message => {
    if (message && message.type === "browser-opt:focus-ttyd") {
      focusTtydTerminal();
    }
  });

  window.addEventListener("focus", () => {
    focusTtydTerminal();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      focusTtydTerminal();
    }
  });
  focusTtydTerminal();
}
