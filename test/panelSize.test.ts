import { describe, expect, it } from "vitest";
import {
  KEY_STEP,
  KEY_STEP_LARGE,
  PANELS,
  clampSize,
  dragSize,
  keyboardSize,
  loadSize,
  saveSize,
  storageKey,
  type SizeStorage,
} from "../src/lib/panelSize";

const spec = { id: "test", defaultSize: 300, min: 200, max: 500 };

function memoryStorage(init: Record<string, string> = {}): SizeStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

const throwing: SizeStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("clampSize", () => {
  it("keeps values within bounds and rounds", () => {
    expect(clampSize(100, spec)).toBe(200);
    expect(clampSize(900, spec)).toBe(500);
    expect(clampSize(321.6, spec)).toBe(322);
  });
  it("treats non-finite values as the minimum", () => {
    expect(clampSize(NaN, spec)).toBe(200);
    expect(clampSize(Infinity, spec)).toBe(200);
  });
  it("tolerates swapped bounds", () => {
    expect(clampSize(50, { min: 400, max: 100 })).toBe(100);
  });
});

describe("dragSize", () => {
  it("grows a panel whose handle is on its right/bottom edge when dragged right/down", () => {
    expect(dragSize(300, 100, 150, "right", spec)).toBe(350);
    expect(dragSize(300, 100, 60, "bottom", spec)).toBe(260);
  });
  it("grows a panel whose handle is on its left/top edge when dragged left/up", () => {
    expect(dragSize(300, 500, 450, "left", spec)).toBe(350);
    expect(dragSize(300, 500, 560, "top", spec)).toBe(240);
  });
  it("clamps to min/max", () => {
    expect(dragSize(300, 0, 1000, "right", spec)).toBe(500);
    expect(dragSize(300, 0, 1000, "left", spec)).toBe(200);
  });
});

describe("keyboardSize", () => {
  it("moves the handle in the arrow's direction", () => {
    expect(keyboardSize("ArrowRight", 300, "right", spec)).toBe(300 + KEY_STEP);
    expect(keyboardSize("ArrowLeft", 300, "right", spec)).toBe(300 - KEY_STEP);
    // Handle on a right-hand panel's left edge: moving it left widens the panel.
    expect(keyboardSize("ArrowLeft", 300, "left", spec)).toBe(300 + KEY_STEP);
    expect(keyboardSize("ArrowDown", 300, "bottom", spec)).toBe(300 + KEY_STEP);
    expect(keyboardSize("ArrowUp", 300, "top", spec)).toBe(300 + KEY_STEP);
  });
  it("uses a larger step with shift and clamps", () => {
    expect(keyboardSize("ArrowRight", 300, "right", spec, true)).toBe(300 + KEY_STEP_LARGE);
    expect(keyboardSize("ArrowRight", 495, "right", spec)).toBe(500);
  });
  it("jumps to min/max with Home/End", () => {
    expect(keyboardSize("Home", 300, "left", spec)).toBe(200);
    expect(keyboardSize("End", 300, "left", spec)).toBe(500);
  });
  it("ignores keys for the other axis and unrelated keys", () => {
    expect(keyboardSize("ArrowUp", 300, "right", spec)).toBeNull();
    expect(keyboardSize("ArrowLeft", 300, "bottom", spec)).toBeNull();
    expect(keyboardSize("a", 300, "right", spec)).toBeNull();
  });
});

describe("persistence", () => {
  it("returns the default when nothing is stored or storage is missing", () => {
    expect(loadSize(spec, memoryStorage())).toBe(300);
    expect(loadSize(spec, undefined)).toBe(300);
  });
  it("round-trips a saved size under a per-panel key", () => {
    const s = memoryStorage();
    saveSize(spec, 420, s);
    expect(s.data[storageKey("test")]).toBe("420");
    expect(loadSize(spec, s)).toBe(420);
    expect(loadSize({ ...spec, id: "other" }, s)).toBe(300);
  });
  it("clamps stored values and ignores garbage", () => {
    expect(loadSize(spec, memoryStorage({ [storageKey("test")]: "9999" }))).toBe(500);
    expect(loadSize(spec, memoryStorage({ [storageKey("test")]: "wide" }))).toBe(300);
    expect(loadSize(spec, memoryStorage({ [storageKey("test")]: "" }))).toBe(300);
  });
  it("clears the entry when saving the default", () => {
    const s = memoryStorage({ [storageKey("test")]: "420" });
    saveSize(spec, 300, s);
    expect(storageKey("test") in s.data).toBe(false);
  });
  it("never throws when storage does", () => {
    expect(loadSize(spec, throwing)).toBe(300);
    expect(() => saveSize(spec, 400, throwing)).not.toThrow();
    expect(() => saveSize(spec, 300, throwing)).not.toThrow();
  });
});

describe("PANELS", () => {
  it("have unique ids and defaults within bounds", () => {
    const all = Object.values(PANELS);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) expect(clampSize(p.defaultSize, p)).toBe(p.defaultSize);
  });
});
