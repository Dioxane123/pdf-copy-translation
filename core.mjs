// Replace each logical line/paragraph/page break with one space; CRLF is one break.
// Preserve existing spaces, tabs, punctuation and hyphens.
export function replaceLineBreaksWithSpaces(text) {
  return text.replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/g, " ");
}

export function documentUrl(raw = "") {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function isPdfUrl(raw) {
  try {
    const url = new URL(raw);
    return ["http:", "https:", "file:"].includes(url.protocol) && /\.pdf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function canMarkTab(raw) {
  try {
    return ["http:", "https:", "file:", "blob:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export function isPdfTab(tab, record = {}) {
  const url = documentUrl(tab?.url);
  if (!url || !canMarkTab(url)) return false;
  if (record.url === url) {
    if (record.manual) return true;
    if (typeof record.pdf === "boolean") return record.pdf;
  }
  return isPdfUrl(url);
}

// Clipboard contents stay in this object and never leave the offscreen document.
export class ClipboardCleaner {
  constructor({ getContext, readText, writeText }) {
    this.getContext = getContext;
    this.readText = readText;
    this.writeText = writeText;
    this.reset();
  }

  reset() {
    this.key = null;
    this.previous = null;
  }

  async tick() {
    const context = await this.getContext();
    if (!context?.key) {
      this.reset();
      return false;
    }
    const text = this.readText();
    // Entering a PDF must not rewrite the clipboard's pre-existing contents.
    if (context.key !== this.key) {
      this.key = context.key;
      this.previous = text;
      return false;
    }
    if (text === this.previous) return false;
    if (text === null || replaceLineBreaksWithSpaces(text) === text) {
      this.previous = text;
      return false;
    }
    const cleaned = replaceLineBreaksWithSpaces(text);
    // Focus can change while the worker responds. Check again before writing.
    const latestContext = await this.getContext();
    if (latestContext?.key !== context.key) {
      this.reset();
      return false;
    }
    // Do not overwrite a newer copy made while awaiting the focus check.
    if (this.readText() !== text) return false;
    this.writeText(cleaned);
    this.previous = cleaned;
    return true;
  }
}
