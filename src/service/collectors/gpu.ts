import { readdir } from 'node:fs/promises';

import { unavailable, type GpuDevice, type GpuStats, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseAmdCards, parseIoreg, parseNvidiaSmi, parseWindowsGpu, type AmdCard } from './parse-gpu.ts';
import { createGpuLoop, NVIDIA_SMI_WIN32 } from './windows.ts';

const NVIDIA_ARGS = ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.gr,power.draw,fan.speed,driver_version', '--format=csv,noheader,nounits'];
const NVIDIA_BASIC_ARGS = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
const WINDOWS_FIRST_SAMPLE_MS = 8_000;

export type GpuCollector = {
  read: () => Promise<GpuStats | Unavailable>;
  /** Ends long-lived helpers; the next `read` starts them again. */
  stop: () => void;
};

const found = (devices: GpuDevice[]): GpuStats | Unavailable =>
  devices.length > 0 ? { status: 'ok', devices } : unavailable('no-device');

type NvidiaResult = { devices: GpuDevice[] } | { missing: boolean };

const readNvidia = async (commands: string[]): Promise<NvidiaResult> => {
  const result = await run(commands, NVIDIA_ARGS);
  if (result.ok) return { devices: parseNvidiaSmi(result.stdout) };
  if (result.missing) return { missing: true };
  // Older drivers/GPU models may not expose one optional sensor field.
  const basic = await run(commands, NVIDIA_BASIC_ARGS);
  if (!basic.ok) return { missing: basic.missing };
  return { devices: parseNvidiaSmi(basic.stdout) };
};

const readAmdCards = async (): Promise<AmdCard[]> => {
  const entries = await readdir('/sys/class/drm').catch(() => [] as string[]);
  const cards = entries.filter((name) => /^card\d+$/.test(name));
  return Promise.all(cards.map(async (card) => {
    const base = `/sys/class/drm/${card}/device`;
    const [vendor, busy, vramUsed, vramTotal] = await Promise.all([
      readText(`${base}/vendor`),
      readText(`${base}/gpu_busy_percent`),
      readText(`${base}/mem_info_vram_used`),
      readText(`${base}/mem_info_vram_total`),
    ]);
    return { card, vendor, busy, vramUsed, vramTotal };
  }));
};

export const createGpuCollector = (platform: Platform): GpuCollector => {
  if (platform === 'darwin') {
    return {
      read: async () => {
        const result = await run(['/usr/sbin/ioreg', 'ioreg'], ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
        if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'ioreg');
        return found(parseIoreg(result.stdout));
      },
      stop: () => undefined,
    };
  }

  if (platform === 'linux') {
    return {
      read: async () => {
        const nvidia = await readNvidia(['nvidia-smi', '/usr/bin/nvidia-smi']);
        if ('devices' in nvidia && nvidia.devices.length > 0) return { status: 'ok', devices: nvidia.devices };
        const amd = parseAmdCards(await readAmdCards());
        if (amd.length > 0) return { status: 'ok', devices: amd };
        // nvidia-smi exists but failed (driver mismatch, no device): say so rather than "no GPU".
        if ('missing' in nvidia && !nvidia.missing) return unavailable('failed', 'nvidia-smi');
        return unavailable('no-device');
      },
      stop: () => undefined,
    };
  }

  if (platform === 'win32') {
    const loop = createGpuLoop();
    let useNvidia = true;
    return {
      read: async () => {
        if (useNvidia) {
          const nvidia = await readNvidia(NVIDIA_SMI_WIN32);
          if ('devices' in nvidia && nvidia.devices.length > 0) return { status: 'ok', devices: nvidia.devices };
          // Without an NVIDIA driver, stop asking until the sampler restarts.
          if ('missing' in nvidia && nvidia.missing) useNvidia = false;
        }
        const sample = await loop.latest(WINDOWS_FIRST_SAMPLE_MS);
        if ('missing' in sample) return sample.missing ? unavailable('tool-missing', 'powershell') : unavailable('failed');
        const devices = parseWindowsGpu(sample.line);
        return devices === null ? unavailable('failed') : found(devices);
      },
      stop: () => {
        useNvidia = true;
        loop.stop();
      },
    };
  }

  return { read: async () => unavailable('unsupported'), stop: () => undefined };
};
