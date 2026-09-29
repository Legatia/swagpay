// Editor state with undo/redo and a draft saved on this device. Storage can be full or blocked
// (private browsing); the editor keeps working either way.
export const DRAFT_KEY = "swagpay-design-draft";

export function loadDraft(storage, key = DRAFT_KEY) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createStore({ initial, storage = null, key = DRAFT_KEY, limit = 50 }) {
  let state = initial;
  const past = [];
  const future = [];
  const subscribers = new Set();
  let problem = null;

  function save() {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(state));
      problem = null;
    } catch {
      try {
        storage.setItem(key, JSON.stringify({ ...state, assets: {} }));
        problem = "assets";
      } catch {
        problem = "all";
      }
    }
  }

  function remember() {
    past.push(state);
    if (past.length > limit) past.shift();
    future.length = 0;
  }

  function emit() {
    for (const fn of subscribers) fn(state);
  }

  return {
    get: () => state,
    set(update, { record = true, persist = true } = {}) {
      const next = typeof update === "function" ? update(state) : { ...state, ...update };
      if (next === state) return;
      if (record) remember();
      state = next;
      if (persist) save();
      emit();
    },
    checkpoint: remember,
    undo() {
      if (!past.length) return false;
      future.push(state);
      state = past.pop();
      save();
      emit();
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(state);
      state = future.pop();
      save();
      emit();
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    saveProblem: () => problem,
    clearDraft() {
      try {
        storage?.removeItem(key);
      } catch {
        /* storage blocked: nothing to clear */
      }
    },
  };
}
