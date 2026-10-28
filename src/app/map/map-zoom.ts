// Shared zoom math for the radar views: the slider is 0..100, mapped
// exponentially onto a viewBox half-extent in map px so the close end
// gets fine granularity; 0 means whole-map fit (radius undefined).
// Each view persists its own % under its own localStorage key.
export const MIN_R = 24;

export const radiusFor = (v: number, ms: number) =>
  v <= 0
    ? undefined
    : Math.round(MIN_R * Math.pow(ms / 2 / MIN_R, (100 - v) / 100));

export const loadZoom = (key: string, fallback: number) => {
  const stored = localStorage.getItem(key);
  const v = stored == null ? NaN : Number(stored);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
};

export const saveZoom = (key: string, v: number) =>
  localStorage.setItem(key, String(v));

// hidden entity kinds — shared by /map and /minimap so the chips on
// the map page also filter the floating radar; storage events carry
// changes to the already-open window
export const HIDE_KEY = 'xicompanion.map.hide';

export const loadHidden = (): ReadonlySet<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};

export const saveHidden = (s: ReadonlySet<string>) =>
  localStorage.setItem(HIDE_KEY, JSON.stringify([...s]));
