import test from "node:test";
import assert from "node:assert/strict";
import { replaceLineBreaksWithSpaces, isPdfUrl, isPdfTab, documentUrl, ClipboardCleaner } from "../core.mjs";

function fixture() {
  const state = { context: { key: "pdf-1" }, text: "旧\n剪贴板", reads: 0, writes: [] };
  const cleaner = new ClipboardCleaner({
    getContext: async () => state.context,
    readText: () => { state.reads++; return state.text; },
    writeText: (text) => { state.writes.push(text); state.text = text; },
  });
  return { state, cleaner };
}

test("replaces each logical line break with a space, treating CRLF as one break", () => {
  assert.equal(replaceLineBreaksWithSpaces("甲\r\n乙\n\n丙\r丁\v戊\f己\u0085庚\u2028辛\u2029壬"), "甲 乙  丙 丁 戊 己 庚 辛 壬");
  assert.equal(replaceLineBreaksWithSpaces(" hello \nworld\t hy-\nphen! "), " hello  world\t hy- phen! ");
  assert.equal(replaceLineBreaksWithSpaces("hello\nworld"), "hello world");
  assert.equal(replaceLineBreaksWithSpaces("\r\n\n"), "  ");
});

test("recognizes PDF paths, not a PDF string in a web page query", () => {
  for (const url of ["https://example.org/a.PDF?q=1#page=2", "file:///tmp/a%20b.pdf"]) assert.ok(isPdfUrl(url));
  for (const url of ["https://example.org/?file=a.pdf", "https://example.org/a.pdf.html", "chrome://settings", "invalid"]) assert.equal(isPdfUrl(url), false);
});

test("MIME detection overrides filename and manual state belongs to one document", () => {
  const tab = { url: "https://example.org/download?id=1#page=2" };
  const url = documentUrl(tab.url);
  assert.ok(isPdfTab(tab, { url, pdf: true }));
  assert.ok(isPdfTab(tab, { url, manual: true }));
  assert.equal(isPdfTab(tab, { url: "https://example.org/other", manual: true }), false);
  assert.equal(isPdfTab({ url: "https://example.org/error.pdf" }, { url: "https://example.org/error.pdf", pdf: false }), false);
  assert.equal(isPdfTab({ url: "chrome://settings" }, { url: "chrome://settings", manual: true }), false);
  assert.ok(isPdfTab({ url: "blob:https://example.org/id" }, { url: "blob:https://example.org/id", manual: true }));
});

test("entering a PDF establishes a baseline without changing the clipboard", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  await cleaner.tick();
  assert.equal(state.text, "旧\n剪贴板");
  assert.deepEqual(state.writes, []);
});

test("cleans new copies once and handles copying the same PDF selection again", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  state.text = "新\n内容";
  assert.equal(await cleaner.tick(), true);
  assert.equal(state.text, "新 内容");
  assert.equal(await cleaner.tick(), false);
  state.text = "新\n内容";
  assert.equal(await cleaner.tick(), true);
  assert.deepEqual(state.writes, ["新 内容", "新 内容"]);
});

test("does not read outside an active PDF, or clean old contents on returning", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  state.context = null;
  const reads = state.reads;
  state.text = "其他\n应用";
  await cleaner.tick();
  assert.equal(state.reads, reads);
  state.context = { key: "pdf-2" };
  await cleaner.tick();
  assert.deepEqual(state.writes, []);
});

test("focus loss between reading and writing cancels a pending cleanup", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  let calls = 0;
  cleaner.getContext = async () => ++calls === 1 ? state.context : null;
  state.text = "新\n内容";
  await cleaner.tick();
  assert.deepEqual(state.writes, []);
});

test("another copy while checking focus is never overwritten with the older text", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  let calls = 0;
  cleaner.getContext = async () => {
    if (++calls === 2) state.text = "稍后复制的文字";
    return state.context;
  };
  state.text = "新\n内容";
  await cleaner.tick();
  assert.equal(state.text, "稍后复制的文字");
  assert.deepEqual(state.writes, []);
});

test("ignores images, files and text without line breaks; replaces newline-only text with spaces", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  for (const value of [null, "单行", ""]) {
    state.text = value;
    await cleaner.tick();
  }
  assert.deepEqual(state.writes, []);
  state.text = "\r\n\f";
  await cleaner.tick();
  assert.deepEqual(state.writes, ["  "]);
});

test("failed writes are not marked as successfully cleaned", async () => {
  const { state, cleaner } = fixture();
  await cleaner.tick();
  state.text = "新\n内容";
  const write = cleaner.writeText;
  cleaner.writeText = () => { throw new Error("blocked"); };
  await assert.rejects(cleaner.tick(), /blocked/);
  cleaner.writeText = write;
  assert.equal(await cleaner.tick(), true);
  assert.equal(state.text, "新 内容");
});
