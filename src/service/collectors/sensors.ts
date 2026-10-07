import { readdir } from 'node:fs/promises';

import { unavailable, type Platform, type SensorStats, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseHwmonReading, parseNvidiaTemperatures } from './parse-sensors.ts';

const readLinux = async (): Promise<SensorStats | Unavailable> => {
  let controllers: string[];
  try { controllers = await readdir('/sys/class/hwmon'); }
  catch { return unavailable('no-device'); }
  const readings = [];
  for (const controller of controllers.slice(0, 64)) {
    const base = `/sys/class/hwmon/${controller}`;
    const [chip, files] = await Promise.all([readText(`${base}/name`), readdir(base).catch(() => [])]);
    if (!chip) continue;
    const inputs = files.filter((name) => /^temp\d+_input$/.test(name)).slice(0, 32);
    for (const input of inputs) {
      const index = /^temp(\d+)_input$/.exec(input)?.[1];
      if (!index) continue;
      const [raw, label] = await Promise.all([
        readText(`${base}/${input}`), readText(`${base}/temp${index}_label`),
      ]);
      if (raw === null) continue;
      const parsed = parseHwmonReading(chip, label ?? `Sensor ${index}`, raw);
      if (parsed) readings.push(parsed);
    }
  }
  const nvidia = await run(['nvidia-smi'], ['--query-gpu=name,temperature.gpu', '--format=csv,noheader,nounits']);
  if (nvidia.ok) readings.push(...parseNvidiaTemperatures(nvidia.stdout));
  return readings.length > 0 ? { status: 'ok', readings, sampledAt: Date.now() } : unavailable('no-device');
};

const readNvidia = async (): Promise<SensorStats | Unavailable> => {
  const result = await run(['nvidia-smi.exe', 'nvidia-smi'], ['--query-gpu=name,temperature.gpu', '--format=csv,noheader,nounits']);
  if (!result.ok) return unavailable(result.missing ? 'no-device' : 'failed', result.missing ? null : 'nvidia-smi');
  const readings = parseNvidiaTemperatures(result.stdout);
  return readings.length > 0 ? { status: 'ok', readings, sampledAt: Date.now() } : unavailable('no-device');
};

export const readSensors = async (platform: Platform): Promise<SensorStats | Unavailable> => {
  if (platform === 'linux') return readLinux();
  if (platform === 'win32') return readNvidia();
  return unavailable(platform === 'darwin' ? 'unsupported' : 'unsupported');
};
