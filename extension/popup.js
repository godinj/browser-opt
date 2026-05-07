const status = document.getElementById("status");

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
