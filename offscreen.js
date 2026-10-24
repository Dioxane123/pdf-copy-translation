import { ClipboardCleaner } from "./core.mjs";

const field = document.getElementById("clipboard");

function readText() {
  let value = null;
  let received = false;
  const onPaste = (event) => {
    // Never insert HTML into the DOM or load resources from copied rich text.
    event.preventDefault();
    received = true;
    const data = event.clipboardData;
    if (data && data.files.length === 0 && Array.from(data.types).includes("text/plain")) {
      value = data.getData("text/plain");
    }
  };
  field.value = "";
  field.focus();
  document.addEventListener("paste", onPaste, true);
  try {
    const success = document.execCommand("paste");
    if (!success && !received) throw new Error("Clipboard read failed");
    return value;
  } finally {
    document.removeEventListener("paste", onPaste, true);
    field.value = "";
  }
}

function writeText(text) {
  let written = false;
  const onCopy = (event) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    written = true;
  };
  // Select a placeholder; the copy event writes the exact normalized text.
  field.value = " ";
  field.focus();
  field.select();
  document.addEventListener("copy", onCopy, true);
  try {
    if (!document.execCommand("copy") || !written) throw new Error("Clipboard write failed");
  } finally {
    document.removeEventListener("copy", onCopy, true);
    field.value = "";
  }
}

const cleaner = new ClipboardCleaner({
  getContext: () => chrome.runtime.sendMessage({ target: "background", type: "context" }),
  readText,
  writeText,
});
let healthy;
async function poll() {
  let ok = true;
  try {
    await cleaner.tick();
  } catch {
    ok = false;
    cleaner.reset();
  }
  if (healthy !== ok) {
    healthy = ok;
    await chrome.runtime.sendMessage({ target: "background", type: "health", ok }).catch(() => {});
  }
  // Sequential polling: never overlap clipboard operations.
  setTimeout(poll, ok ? 150 : 1500);
}
void poll();
