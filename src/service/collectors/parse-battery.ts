import type { BatteryStats } from '../../shared/stats.ts';

const number = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const capacityHealth = (full: unknown, design: unknown): number | null => {
  const fullValue = number(full);
  const designValue = number(design);
  return fullValue !== null && designValue !== null && designValue > 0
    ? Math.min(100, (fullValue / designValue) * 100)
    : null;
};

export const parseLinuxBattery = (input: {
  capacity: string | null; status: string | null; energyNow: string | null;
  energyFull: string | null; energyFullDesign: string | null; powerNow: string | null; acOnline: string | null;
}): BatteryStats | null => {
  const percent = number(input.capacity);
  if (percent === null || percent > 100) return null;
  const stateText = input.status?.trim().toLowerCase();
  const state = stateText === 'charging' ? 'charging'
    : stateText === 'discharging' ? 'discharging'
      : stateText === 'full' ? 'full' : 'unknown';
  const energyNow = number(input.energyNow);
  const energyFull = number(input.energyFull);
  const healthPercent = capacityHealth(input.energyFull, input.energyFullDesign);
  const powerNow = number(input.powerNow);
  const remainingEnergy = state === 'charging' && energyFull !== null && energyNow !== null
    ? Math.max(0, energyFull - energyNow)
    : energyNow;
  const remainingSeconds = powerNow !== null && powerNow > 0 && remainingEnergy !== null
    ? Math.round(remainingEnergy / powerNow * 3600) : null;
  const ac = input.acOnline?.trim();
  return {
    status: 'ok', percent, state,
    acConnected: ac === '1' ? true : ac === '0' ? false : null,
    remainingSeconds,
    healthPercent,
  };
};

export const parseWindowsBattery = (text: string): BatteryStats | null => {
  let value: unknown;
  try { value = JSON.parse(text.trim() || 'null'); } catch { return null; }
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== 'object' || row === null) return null;
  const get = (key: string) => Reflect.get(row, key);
  const percent = number(get('EstimatedChargeRemaining'));
  const batteryStatus = number(get('BatteryStatus'));
  if (percent === null || percent > 100) return null;
  const state = batteryStatus === 3 ? 'full'
    : batteryStatus !== null && [6, 7, 8, 9, 10, 11, 12].includes(batteryStatus) ? 'charging'
      : batteryStatus === 1 || batteryStatus === 4 || batteryStatus === 5 ? 'discharging' : 'unknown';
  const runtimeMinutes = number(get('EstimatedRunTime'));
  const remainingSeconds = runtimeMinutes !== null && runtimeMinutes > 0 && runtimeMinutes < 71582788
    ? runtimeMinutes * 60 : null;
  return {
    status: 'ok', percent, state,
    acConnected: batteryStatus === null ? null : [2, 3, 6, 7, 8, 9, 10, 11, 12, 14].includes(batteryStatus),
    remainingSeconds,
    healthPercent: capacityHealth(get('FullChargeCapacity'), get('DesignCapacity')),
  };
};

export const parseDarwinBattery = (text: string): BatteryStats | null => {
  const header = /Now drawing from ['"]([^'"]+)['"]/.exec(text);
  const line = /([0-9]{1,3})%;\s*([^\n]*)/i.exec(text);
  if (!line?.[1]) return null;
  const percent = Number(line[1]);
  if (!Number.isFinite(percent) || percent > 100) return null;
  const stateText = line[2]?.toLowerCase() ?? '';
  const state = /\bcharging\b|\bfinishing charge\b/i.test(stateText) ? 'charging'
    : /\bdischarging\b/i.test(stateText) ? 'discharging'
      : /\bcharged\b/i.test(stateText) ? 'full' : 'unknown';
  const remaining = /\((\d+):(\d+)\s+remaining\)/i.exec(stateText);
  const hours = remaining?.[1] === undefined ? null : Number(remaining[1]);
  const minutes = remaining?.[2] === undefined ? null : Number(remaining[2]);
  return {
    status: 'ok', percent, state,
    acConnected: header?.[1] === 'AC Power' ? true : header?.[1] === 'Battery Power' ? false : null,
    remainingSeconds: hours !== null && minutes !== null ? (hours * 60 + minutes) * 60 : null,
    healthPercent: null,
  };
};
