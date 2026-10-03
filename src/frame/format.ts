import { format, type Messages } from '../i18n/messages.ts';
import type { Unavailable } from '../shared/stats.ts';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Binary sizes with decimal-looking units, like Finder and Explorer: 17.6 GB. */
export const formatBytes = (bytes: number, locale: string): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
};

export const formatPercent = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(Math.round(value) / 100);

export const formatNumber = (value: number, locale: string, digits = 2): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);

export const formatCores = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

export const describeUnavailable = (source: Unavailable, t: Messages): string => {
  if (source.reason === 'tool-missing') return format(t.reasonToolMissing, { tool: source.tool ?? '?' });
  if (source.reason === 'no-device') return t.reasonNoDevice;
  if (source.reason === 'unsupported') return t.reasonUnsupported;
  return t.reasonFailed;
};
