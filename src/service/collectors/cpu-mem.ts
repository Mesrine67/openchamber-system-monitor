import os from 'node:os';

import { unavailable, type CpuStats, type MemoryStats, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseCgroupMemory, parseMeminfo, parseSwapUsage, parseVmStat } from './parse-memory.ts';
import {
  cpuUsage,
  limitedCpuUsage,
  parseCfsQuota,
  parseCpuMax,
  parseCpuStatUsage,
  type CoreTimes,
} from './parse-cpu.ts';

const CGROUP = '/sys/fs/cgroup';

const coreTimes = (): CoreTimes[] => os.cpus().map((cpu) => cpu.times);

/** Container CPU limit in cores and the cgroup's usage counter (µs); v2 first, then v1. */
const readCgroupCpu = async (): Promise<{ limitCores: number | null; usageUsec: number | null }> => {
  const v2Limit = await readText(`${CGROUP}/cpu.max`);
  if (v2Limit !== null) {
    return { limitCores: parseCpuMax(v2Limit), usageUsec: parseCpuStatUsage(await readText(`${CGROUP}/cpu.stat`)) };
  }
  for (const dir of ['cpu,cpuacct', 'cpu']) {
    const quota = await readText(`${CGROUP}/${dir}/cpu.cfs_quota_us`);
    if (quota === null) continue;
    const limitCores = parseCfsQuota(quota, await readText(`${CGROUP}/${dir}/cpu.cfs_period_us`));
    const usageNs = Number((await readText(`${CGROUP}/${dir}/cpuacct.usage`) ?? await readText(`${CGROUP}/cpuacct/cpuacct.usage`) ?? '').trim());
    return { limitCores, usageUsec: Number.isFinite(usageNs) && usageNs > 0 ? usageNs / 1000 : null };
  }
  return { limitCores: null, usageUsec: null };
};

const readCgroupMemory = async (): Promise<{ used: number; total: number } | null> => {
  const v2 = parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory.max`),
    usage: await readText(`${CGROUP}/memory.current`),
    stat: await readText(`${CGROUP}/memory.stat`),
  });
  if (v2) return v2;
  return parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory/memory.limit_in_bytes`),
    usage: await readText(`${CGROUP}/memory/memory.usage_in_bytes`),
    stat: await readText(`${CGROUP}/memory/memory.stat`),
  });
};

export type CpuMemCollector = {
  /** Takes the baseline the first CPU reading is measured against. */
  prime: () => Promise<void>;
  cpu: () => Promise<CpuStats | Unavailable>;
  memory: () => Promise<MemoryStats | Unavailable>;
};

export const createCpuMemCollector = (platform: Platform, container: boolean, now: () => number): CpuMemCollector => {
  let previousTimes: CoreTimes[] = [];
  let previousCgroup: { usageUsec: number; at: number } | null = null;

  const readCgroupBaseline = async () => {
    if (!container) return;
    const { usageUsec } = await readCgroupCpu();
    previousCgroup = usageUsec === null ? null : { usageUsec, at: now() };
  };

  return {
    prime: async () => {
      previousTimes = coreTimes();
      await readCgroupBaseline();
    },

    cpu: async () => {
      const times = coreTimes();
      const host = cpuUsage(previousTimes, times);
      previousTimes = times;
      const load = platform === 'win32' ? null : os.loadavg();
      const base = {
        cores: times.length,
        model: os.cpus()[0]?.model.trim() || null,
        load: load ? [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] as [number, number, number] : null,
      };

      if (container) {
        const { limitCores, usageUsec } = await readCgroupCpu();
        const before = previousCgroup;
        const at = now();
        previousCgroup = usageUsec === null ? null : { usageUsec, at };
        if (limitCores !== null) {
          const total = before && usageUsec !== null
            ? limitedCpuUsage(before.usageUsec, usageUsec, at - before.at, limitCores)
            : null;
          if (total === null) return unavailable('failed');
          // Per-core bars would show the host's cores, not the container's share.
          return { status: 'ok', total, perCore: [], limitCores, ...base };
        }
      }

      if (!host) return unavailable('failed');
      return { status: 'ok', total: host.total, perCore: host.perCore, limitCores: null, ...base };
    },

    memory: async () => {
      if (container) {
        const limited = await readCgroupMemory();
        if (limited) return { status: 'ok', used: limited.used, total: limited.total, swapUsed: null, swapTotal: null };
      }
      if (platform === 'linux') {
        const info = parseMeminfo(await readText('/proc/meminfo') ?? '');
        if (!info) return unavailable('failed');
        return {
          status: 'ok',
          used: info.total - info.available,
          total: info.total,
          swapUsed: info.swapTotal > 0 ? info.swapTotal - info.swapFree : null,
          swapTotal: info.swapTotal > 0 ? info.swapTotal : null,
        };
      }
      if (platform === 'darwin') {
        const [vm, swap] = await Promise.all([
          run(['/usr/bin/vm_stat', 'vm_stat'], []),
          run(['/usr/sbin/sysctl', 'sysctl'], ['vm.swapusage']),
        ]);
        if (!vm.ok) return unavailable(vm.missing ? 'tool-missing' : 'failed', 'vm_stat');
        const used = parseVmStat(vm.stdout);
        if (used === null) return unavailable('failed');
        const swapUsage = swap.ok ? parseSwapUsage(swap.stdout) : null;
        return {
          status: 'ok',
          used,
          total: os.totalmem(),
          swapUsed: swapUsage && swapUsage.total > 0 ? swapUsage.used : null,
          swapTotal: swapUsage && swapUsage.total > 0 ? swapUsage.total : null,
        };
      }
      // Windows (and anything else): Node's own numbers are correct there.
      const total = os.totalmem();
      return { status: 'ok', used: total - os.freemem(), total, swapUsed: null, swapTotal: null };
    },
  };
};
