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
