import { describe, expect, it } from "vitest";
import { DRAFT_KEY, createStore, loadDraft } from "../../public/design/js/store.js";

function memoryStorage({ failOver = Infinity, broken = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => { if (broken) throw new Error("blocked"); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error("blocked"); if (v.length > failOver) throw new Error("QuotaExceededError"); data.set(k, v); },
    removeItem: (k) => data.delete(k),
  };
}

describe("store", () => {
  it("merges updates and notifies subscribers", () => {
    const s = createStore({ initial: { a: 1, b: 1 } });
    const seen = [];
    s.subscribe((st) => seen.push(st.a));
    s.set({ a: 2 });
    s.set((st) => ({ ...st, a: st.a + 1 }));
    expect(s.get()).toEqual({ a: 3, b: 1 });
    expect(seen).toEqual([2, 3]);
  });
  it("undoes and redoes recorded changes only", () => {
    const s = createStore({ initial: { n: 0 } });
    s.set({ n: 1 });
    s.set({ n: 2 }, { record: false });
    s.set({ n: 3 });
    expect(s.undo()).toBe(true);
    expect(s.get().n).toBe(2);
    expect(s.undo()).toBe(true);
    expect(s.get().n).toBe(0);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(true);
    expect(s.get().n).toBe(2);
  });
  it("keeps the listed keys when undoing and redoing", () => {
    const s = createStore({ initial: { n: 0, step: "design", sizes: {} }, keep: ["step", "sizes"] });
    s.set({ n: 1 });
    s.set({ step: "details", sizes: { M: "20" } }, { record: false });
    s.set({ step: "design" }, { record: false });
    expect(s.undo()).toBe(true);
    expect(s.get()).toEqual({ n: 0, step: "design", sizes: { M: "20" } });
    s.set({ step: "review", sizes: { M: "30" } }, { record: false });
    expect(s.redo()).toBe(true);
    expect(s.get()).toEqual({ n: 1, step: "review", sizes: { M: "30" } });
  });
  it("treats a gesture as one undo step through checkpoint", () => {
    const s = createStore({ initial: { x: 0 } });
    s.checkpoint();
    for (let i = 1; i <= 5; i++) s.set({ x: i }, { record: false, persist: false });
    s.undo();
    expect(s.get().x).toBe(0);
  });
  it("saves drafts and loads them back", () => {
    const storage = memoryStorage();
    const s = createStore({ initial: { n: 0, assets: {} }, storage });
    s.set({ n: 5 });
    expect(loadDraft(storage)).toEqual({ n: 5, assets: {} });
    expect(DRAFT_KEY).toBe("swagpay-design-draft");
  });
  it("drops images when storage is full and says so", () => {
    const storage = memoryStorage({ failOver: 200 });
    const s = createStore({ initial: { n: 0, assets: {} }, storage });
    s.set({ assets: { "logo-1": { dataUrl: "x".repeat(500) } } });
    expect(s.saveProblem()).toBe("assets");
    expect(loadDraft(storage).assets).toEqual({});
    expect(s.get().assets["logo-1"].dataUrl.length).toBe(500);
  });
  it("keeps working when storage is blocked", () => {
    const storage = memoryStorage({ broken: true });
    const s = createStore({ initial: { n: 0, assets: {} }, storage });
    s.set({ n: 1 });
    expect(s.get().n).toBe(1);
    expect(s.saveProblem()).toBe("all");
    expect(loadDraft(storage)).toBeNull();
  });
  it("does not save while a gesture is moving", () => {
    const storage = memoryStorage();
    const s = createStore({ initial: { x: 0, assets: {} }, storage });
    s.set({ x: 1 }, { record: false, persist: false });
    expect(storage.data.size).toBe(0);
  });
  it("stops saving after finish()", () => {
    const storage = memoryStorage();
    const s = createStore({ initial: { a: 1 }, storage });
    s.set({ a: 2 });
    expect(storage.data.has(DRAFT_KEY)).toBe(true);
    s.finish();
    expect(storage.data.has(DRAFT_KEY)).toBe(false);
    s.set({ a: 3 });
    s.undo();
    s.redo();
    expect(storage.data.has(DRAFT_KEY)).toBe(false);
    expect(s.get().a).toBe(3);
  });
});
