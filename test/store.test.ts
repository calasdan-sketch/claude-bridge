import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

describe("Store CRUD + search", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("create requires a title", () => {
    assert.throws(() => store.create({ title: "" } as any), /title is required/);
  });

  test("create + read round-trip", () => {
    const note = store.create({ title: "Hello", body: "World", tags: ["a", "b"] });
    assert.equal(note.title, "Hello");
    assert.equal(note.body, "World");
    assert.deepEqual(note.tags, ["a", "b"]);
    assert.equal(note.namespace, "default");
    assert.ok(note.id > 0);

    const fetched = store.read(note.id);
    assert.deepEqual(fetched, note);
  });

  test("read returns null for missing id", () => {
    assert.equal(store.read(99999), null);
  });

  test("create defaults namespace and body", () => {
    const note = store.create({ title: "Bare" });
    assert.equal(note.namespace, "default");
    assert.equal(note.body, "");
    assert.deepEqual(note.tags, []);
  });

  test("namespace is respected", () => {
    const note = store.create({ title: "Scoped", namespace: "jarvis" });
    assert.equal(note.namespace, "jarvis");
  });

  test("update patches only given fields", () => {
    const note = store.create({ title: "Original", body: "Body1", tags: ["x"] });
    const updated = store.update(note.id, { body: "Body2" });
    assert.ok(updated);
    assert.equal(updated!.title, "Original");
    assert.equal(updated!.body, "Body2");
    assert.deepEqual(updated!.tags, ["x"]);
  });

  test("update returns null for missing id", () => {
    assert.equal(store.update(99999, { body: "x" }), null);
  });

  test("update rejects blowing away the title with empty string", () => {
    const note = store.create({ title: "Keep me" });
    assert.throws(() => store.update(note.id, { title: "  " }), /title cannot be empty/);
  });

  test("update bumps updated_at but not created_at", async () => {
    const note = store.create({ title: "Time test" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(note.id, { body: "changed" });
    assert.equal(updated!.created_at, note.created_at);
    assert.notEqual(updated!.updated_at, note.created_at);
  });

  test("list returns notes newest-updated first with total count", () => {
    store.create({ title: "One" });
    store.create({ title: "Two" });
    store.create({ title: "Three" });
    const { notes, total } = store.list();
    assert.equal(total, 3);
    assert.equal(notes.length, 3);
    assert.equal(notes[0].title, "Three");
  });

  test("list filters by namespace", () => {
    store.create({ title: "A", namespace: "ns1" });
    store.create({ title: "B", namespace: "ns2" });
    const { notes, total } = store.list({ namespace: "ns1" });
    assert.equal(total, 1);
    assert.equal(notes[0].title, "A");
  });

  test("list respects limit/offset and clamps limit", () => {
    for (let i = 0; i < 5; i++) store.create({ title: `Item ${i}` });
    const page1 = store.list({ limit: 2, offset: 0 });
    const page2 = store.list({ limit: 2, offset: 2 });
    assert.equal(page1.notes.length, 2);
    assert.equal(page2.notes.length, 2);
    assert.notDeepEqual(page1.notes, page2.notes);

    const clamped = store.list({ limit: 100000 });
    assert.ok(clamped.notes.length <= 500);
  });

  test("search finds notes by title/body/tags", () => {
    store.create({ title: "Rocket Launch", body: "Countdown begins", tags: ["space"] });
    store.create({ title: "Grocery list", body: "milk eggs bread", tags: ["home"] });

    assert.equal(store.search("rocket").length, 1);
    assert.equal(store.search("countdown").length, 1);
    assert.equal(store.search("space").length, 1);
    assert.equal(store.search("milk").length, 1);
    assert.equal(store.search("nonexistentword").length, 0);
  });

  test("search is empty for empty query", () => {
    store.create({ title: "Anything" });
    assert.deepEqual(store.search(""), []);
    assert.deepEqual(store.search("   "), []);
  });

  test("search reflects updates immediately (no stale index)", () => {
    const note = store.create({ title: "Alpha", body: "original content" });
    assert.equal(store.search("original").length, 1);
    assert.equal(store.search("revised").length, 0);

    store.update(note.id, { body: "revised content" });

    assert.equal(store.search("original").length, 0, "stale match after update");
    assert.equal(store.search("revised").length, 1, "new content not indexed after update");
  });

  test("search excludes deleted notes", () => {
    const note = store.create({ title: "Ephemeral", body: "will vanish" });
    assert.equal(store.search("vanish").length, 1);
    store.delete(note.id);
    assert.equal(store.search("vanish").length, 0);
  });

  test("search respects namespace filter", () => {
    store.create({ title: "Match", body: "needle", namespace: "ns1" });
    store.create({ title: "Match2", body: "needle", namespace: "ns2" });
    assert.equal(store.search("needle").length, 2);
    assert.equal(store.search("needle", { namespace: "ns1" }).length, 1);
  });

  test("search handles special characters without throwing", () => {
    store.create({ title: 'Quote "test"', body: "a-b/c:d" });
    assert.doesNotThrow(() => store.search('"weird" query/with:chars'));
  });

  test("delete removes the note", () => {
    const note = store.create({ title: "Temp" });
    assert.equal(store.delete(note.id), true);
    assert.equal(store.read(note.id), null);
    assert.equal(store.delete(note.id), false);
  });
});
