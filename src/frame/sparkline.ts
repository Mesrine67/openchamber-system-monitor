import { HISTORY_LENGTH } from '../shared/stats.ts';

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH = HISTORY_LENGTH - 1;
const HEIGHT = 100;

/**
 * Line and soft area for 0..100 points, oldest left. Gaps (`null`) split the
 * line rather than drawing it at 0. Right-aligned, so a short history grows
 * in from the right like a live chart.
 */
export const sparkline = (points: (number | null)[], label: string): SVGSVGElement => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const offset = HISTORY_LENGTH - points.length;
  const segments: string[][] = [];
  let segment: string[] = [];
  points.forEach((point, index) => {
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

export const SPARKLINE_CSS = `
.spark{display:block;width:100%;height:36px;border-bottom:1px solid var(--oc-border)}
.spark-area{fill:var(--oc-primary);opacity:.14}
.spark-line{fill:none;stroke:var(--oc-primary);stroke-width:1.5;stroke-linejoin:round}
`;
