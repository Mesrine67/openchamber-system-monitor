import type { SensorReading } from '../../shared/stats.ts';

export const parseHwmonReading = (chip: string, label: string, raw: string): SensorReading | null => {
  const milliCelsius = Number(raw.trim());
  const temperatureC = milliCelsius / 1000;
  if (!Number.isFinite(milliCelsius) || temperatureC < -40 || temperatureC > 150) return null;
  const name = `${chip.trim()} ${label.trim()}`.trim().slice(0, 80);
  if (!name) return null;
  const probe = `${chip} ${label}`.toLowerCase();
  const kind = /nvme|drivetemp|drive temperature/.test(probe) ? 'disk'
    : /amdgpu|i915|nouveau|nvidia|gpu/.test(probe) ? 'gpu'
      : /cpu|coretemp|k10temp|zenpower|package/.test(probe) ? 'cpu' : 'other';
  return { name, kind, temperatureC: Math.round(temperatureC * 10) / 10 };
};

export const parseNvidiaTemperatures = (text: string): SensorReading[] => text.split(/\r?\n/).flatMap((line, index) => {
  const [name, raw] = line.split(',').map((part) => part?.trim());
  const value = Number(raw);
  if (!name || !Number.isFinite(value) || value < -40 || value > 150) return [];
  return [{ name: `${name} GPU`, kind: 'gpu' as const, temperatureC: value }];
});
