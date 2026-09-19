export type LayoutPreset = "solo" | "side_by_side" | "front_back" | "over_shoulder_pair" | "circle" | "custom";
export type Point = { x: number; y: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const rounded = (n: number) => Math.round(clamp(n, 0.03, 0.97) * 1000) / 1000;
const row = (count: number, y: number): Point[] => Array.from({ length: count }, (_, i) => ({ x: rounded(count === 1 ? 0.5 : 0.08 + 0.84 * i / (count - 1)), y: rounded(y) }));
const twoRows = (count: number): Point[] => { const first = Math.ceil(count / 2); return [...row(first, 0.42), ...row(count - first, 0.72)]; };

/** Deterministic member positions used by the editor and generation service. */
export function layoutFor(preset: LayoutPreset, count: number): Point[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0.5, y: 0.5 }];
  let points: Point[];
  switch (preset) {
    case "front_back": points = twoRows(count); break;
    case "over_shoulder_pair": points = count <= 2 ? [{ x: 0.38, y: 0.5 }, { x: 0.68, y: 0.45 }].slice(0, count) : twoRows(count); break;
    case "circle": {
      const radius = Math.min(0.45, Math.max(0.28, (0.15 * 1.1) / 2 / Math.sin(Math.PI / count)));
      points = Array.from({ length: count }, (_, i) => {
        const theta = -Math.PI / 2 + 2 * Math.PI * i / count;
        return { x: rounded(0.5 + radius * Math.cos(theta)), y: rounded(0.5 + radius * Math.sin(theta)) };
      });
      break;
    }
    default: points = count <= 6 ? row(count, 0.55) : twoRows(count);
  }
  return points.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
}
