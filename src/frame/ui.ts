import { mountProgress, type ProgressHandle, type Tone } from '@openchamber/sdk/ui';

import type { WarningLevel } from '../shared/stats.ts';

export const BASE_CSS = `
*{box-sizing:border-box}
[data-oc-theme="dark"]{color-scheme:dark}
[data-oc-theme="light"]{color-scheme:light}
html,body{margin:0;color:var(--oc-fg);font:12px/1.4 var(--oc-font);font-variant-numeric:tabular-nums}
[hidden]{display:none!important}
.muted{color:var(--oc-muted)}
.meter{display:flex;flex-direction:column;gap:3px;min-width:0}
.meter-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.meter-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meter-value{flex:none;color:var(--oc-muted)}
.meter-value.warn{color:var(--oc-warning-text)}
.meter-value.critical{color:var(--oc-error-text)}
.meter .oc-sdk-progress{margin:0}
.unavailable{color:var(--oc-muted);font-style:italic}
`;

export const installStyle = (css: string): void => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
};

export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export const toneFor = (level: WarningLevel | null): Tone => {
  if (level === 'critical') return 'error';
  if (level === 'warn') return 'warning';
  return 'primary';
};

export type MeterProps = {
  label: string;
  /** 0..100, or `null` when there is no value; the bar then hides. */
  percent: number | null;
  /** Right-hand text: "12.4 GB of 32 GB", "47 %", or why the value is missing. */
  value: string;
  level: WarningLevel | null;
  /** Shown instead of the bar, muted, when the source is unavailable. */
  unavailable?: boolean;
};

export type Meter = { node: HTMLElement; update: (props: MeterProps) => void };

/** Label and value on one line, the SDK progress bar under them. */
export const createMeter = (parent: HTMLElement): Meter => {
  const node = element('div', 'meter');
  const head = element('div', 'meter-head');
  const label = element('span', 'meter-label');
  const value = element('span', 'meter-value');
  head.append(label, value);
  const barSlot = element('div');
  node.append(head, barSlot);
  parent.append(node);
  let bar: ProgressHandle | null = null;
  return {
    node,
    update: (props) => {
      label.textContent = props.label;
      value.textContent = props.value;
      value.className = `meter-value${props.unavailable ? ' unavailable' : props.level ? ` ${props.level}` : ''}`;
      const show = props.percent !== null && !props.unavailable;
      barSlot.hidden = !show;
      if (!show) return;
      const barProps = { value: props.percent ?? 0, tone: toneFor(props.level), label: undefined };
      if (bar) bar.update(barProps);
      else bar = mountProgress(barSlot, barProps);
      barSlot.querySelector('[role="progressbar"]')?.setAttribute('aria-label', props.label);
    },
  };
};
