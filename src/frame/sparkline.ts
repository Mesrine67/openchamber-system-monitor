const SVG = 'http://www.w3.org/2000/svg';
const MAX_POINTS = 120;
const WIDTH = MAX_POINTS - 1;
const HEIGHT = 100;

const downsample = (points: (number | null)[]): (number | null)[] => {
  if (points.length <= MAX_POINTS) return points;
  const result: (number | null)[] = [];
  const bucketSize = points.length / MAX_POINTS;
  for (let index = 0; index < MAX_POINTS; index++) {
    const start = Math.floor(index * bucketSize);
    const end = Math.floor((index + 1) * bucketSize);
    const known = points.slice(start, Math.max(start + 1, end)).filter((value): value is number => value !== null);
    result.push(known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null);
  }
  return result;
};

/**
 * Line and soft area for 0..100 points, oldest left. Gaps (`null`) split the
 * line rather than drawing it at 0. Right-aligned, so a short history grows
 * in from the right like a live chart.
 */
export const sparkline = (points: (number | null)[], label: string): SVGSVGElement => {
  const sampled = downsample(points);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const offset = MAX_POINTS - sampled.length;
  const segments: string[][] = [];
  let segment: string[] = [];
  sampled.forEach((point, index) => {
    if (point === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    const y = HEIGHT - (Math.min(100, Math.max(0, point)) / 100) * HEIGHT;
    segment.push(`${offset + index},${y.toFixed(1)}`);
  });
  if (segment.length) segments.push(segment);
  for (const coords of segments) {
    const first = coords[0]?.split(',')[0];
    const last = coords[coords.length - 1]?.split(',')[0];
    const area = document.createElementNS(SVG, 'polygon');
    area.setAttribute('points', `${first},${HEIGHT} ${coords.join(' ')} ${last},${HEIGHT}`);
    area.setAttribute('class', 'spark-area');
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', coords.join(' '));
    line.setAttribute('class', 'spark-line');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, line);
  }
  return svg;
};

/** Normalize traffic/rate values to the chart height without changing the underlying values. */
export const sparklineFromValues = (points: (number | null)[], label: string): SVGSVGElement => {
  const max = Math.max(1, ...points.filter((value): value is number => value !== null));
  const normalized = points.map((value) => value === null ? null : Math.max(0, Math.min(100, value / max * 100)));
  const svg = sparkline(normalized, label);
  const title = document.createElementNS(SVG, 'title');
  title.textContent = label;
  svg.prepend(title);
  return svg;
};

export const SPARKLINE_CSS = `
.spark{display:block;width:100%;height:36px;border-bottom:1px solid var(--oc-border)}
.spark-area{fill:var(--oc-primary);opacity:.14}
.spark-line{fill:none;stroke:var(--oc-primary);stroke-width:1.5;stroke-linejoin:round}
`;
