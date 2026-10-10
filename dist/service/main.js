// src/service/main.ts
import http from "node:http";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/service/collectors/cpu-mem.ts
import os from "node:os";
import { readdir } from "node:fs/promises";

// src/shared/stats.ts
var DEFAULT_MONITOR_SETTINGS = {
  paused: false,
  refreshSeconds: 2,
  historyMinutes: 2,
  processLimit: 10,
  modules: { network: true, processes: true, battery: true, sensors: true },
  thresholds: {
    memoryWarning: 85,
    memoryCritical: 95,
    diskWarning: 85,
    diskCritical: 95,
    cpuWarning: 85,
    cpuCritical: 95,
    gpuWarning: 85,
    gpuCritical: 95,
    swapWarning: 50,
    sustainedSeconds: 60
  }
};
var allowed = (value, values, fallback) => typeof value === "number" && values.includes(value) ? value : fallback;
var threshold = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(99, Math.max(50, Math.round(value))) : fallback;
var normalizeMonitorSettings = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return structuredClone(DEFAULT_MONITOR_SETTINGS);
  const modules = Reflect.get(value, "modules");
  const thresholds = Reflect.get(value, "thresholds");
  const read = (source, key) => typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
  const normalizedThresholds = {
    memoryWarning: threshold(read(thresholds, "memoryWarning"), 85),
    memoryCritical: threshold(read(thresholds, "memoryCritical"), 95),
    diskWarning: threshold(read(thresholds, "diskWarning"), 85),
    diskCritical: threshold(read(thresholds, "diskCritical"), 95),
    cpuWarning: threshold(read(thresholds, "cpuWarning"), 85),
    cpuCritical: threshold(read(thresholds, "cpuCritical"), 95),
    gpuWarning: threshold(read(thresholds, "gpuWarning"), 85),
    gpuCritical: threshold(read(thresholds, "gpuCritical"), 95),
    swapWarning: threshold(read(thresholds, "swapWarning"), 50),
    sustainedSeconds: allowed(read(thresholds, "sustainedSeconds"), [30, 60, 120], 60)
  };
  for (const [warning, critical] of [
    ["memoryWarning", "memoryCritical"],
    ["diskWarning", "diskCritical"],
    ["cpuWarning", "cpuCritical"],
    ["gpuWarning", "gpuCritical"]
  ]) {
    if (normalizedThresholds[warning] >= normalizedThresholds[critical]) {
      normalizedThresholds[warning] = Math.max(50, normalizedThresholds[critical] - 5);
    }
  }
  return {
    paused: read(value, "paused") === true,
    refreshSeconds: allowed(read(value, "refreshSeconds"), [2, 5, 10], 2),
    historyMinutes: allowed(read(value, "historyMinutes"), [2, 5, 15, 30], 2),
    processLimit: allowed(read(value, "processLimit"), [5, 10, 20], 10),
    modules: {
      network: read(modules, "network") !== false,
      processes: read(modules, "processes") !== false,
      battery: read(modules, "battery") !== false,
      sensors: read(modules, "sensors") !== false
    },
    thresholds: normalizedThresholds
  };
};
var SAMPLE_INTERVAL_MS = 2000;
var HISTORY_LENGTH = 60;
var WARNING_HISTORY_LENGTH = 60;
var IDLE_STOP_MS = 30000;
var DISK_INTERVAL_MS = 30000;
var RETRY_UNAVAILABLE_MS = 60000;
var FAILURES_BEFORE_UNAVAILABLE = 3;
var WARN_PERCENT = 90;
var unavailable = (reason, tool = null) => ({
  status: "unavailable",
  reason,
  tool
});
var busiestGpu = (gpus) => {
  if (gpus.status !== "ok")
    return null;
  let busiest = null;
  for (const device of gpus.devices) {
    if (device.utilization !== null && (busiest === null || device.utilization > busiest))
      busiest = device.utilization;
  }
  return busiest;
};
var diskPercent = (disk) => disk.total > 0 ? disk.used / disk.total * 100 : null;

// src/service/collectors/exec.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
var EXEC_TIMEOUT_MS = 3000;
var run = async (commands, args, timeout = EXEC_TIMEOUT_MS, env = process.env) => {
  for (const command of commands) {
    const result = await new Promise((resolve) => {
      execFile(command, args, { timeout, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        resolve({ ok: false, missing: "code" in error && error.code === "ENOENT" });
      });
    });
    if (result.ok || !result.missing)
      return result;
  }
  return { ok: false, missing: true };
};
var readText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

// src/service/collectors/parse-memory.ts
var KIB = 1024;
var MIB = 1024 * 1024;
var field = (text, pattern) => {
  const match = pattern.exec(text);
  if (!match?.[1])
    return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};
var parseVmStat = (text) => {
  const pageSize = field(text, /page size of (\d+) bytes/);
  const anonymous = field(text, /^Anonymous pages:\s+(\d+)\./m);
  const purgeable = field(text, /^Pages purgeable:\s+(\d+)\./m);
  const wired = field(text, /^Pages wired down:\s+(\d+)\./m);
  const compressed = field(text, /^Pages occupied by compressor:\s+(\d+)\./m);
  if (pageSize === null || anonymous === null || wired === null || compressed === null)
    return null;
  const app = Math.max(0, anonymous - (purgeable ?? 0));
  return (app + wired + compressed) * pageSize;
};
var SWAP_UNITS = { K: KIB, M: MIB, G: MIB * 1024 };
var parseSwapUsage = (text) => {
  const read = (name) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(text);
    if (!match?.[1] || !match[2])
      return null;
    const unit = SWAP_UNITS[match[2]];
    const value = Number(match[1]);
    return unit && Number.isFinite(value) ? Math.round(value * unit) : null;
  };
  const total = read("total");
  const used = read("used");
  return total === null || used === null ? null : { used, total };
};
var parseWindowsPageFile = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value];
  let total = 0;
  let used = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null)
      continue;
    const allocated = Number(Reflect.get(row, "AllocatedBaseSize"));
    const current = Number(Reflect.get(row, "CurrentUsage"));
    if (!Number.isFinite(allocated) || !Number.isFinite(current) || allocated < 0 || current < 0)
      continue;
    total += allocated * MIB;
    used += current * MIB;
  }
  return total > 0 ? { total, used: Math.min(used, total) } : null;
};
var parseMeminfo = (text) => {
  const read = (name) => field(text, new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
  const total = read("MemTotal");
  const available = read("MemAvailable");
  if (total === null || available === null)
    return null;
  return {
    total: total * KIB,
    available: available * KIB,
    swapTotal: (read("SwapTotal") ?? 0) * KIB,
    swapFree: (read("SwapFree") ?? 0) * KIB,
    cached: read("Cached") === null ? null : (read("Cached") ?? 0) * KIB,
    committed: read("Committed_AS") === null ? null : (read("Committed_AS") ?? 0) * KIB,
    commitLimit: read("CommitLimit") === null ? null : (read("CommitLimit") ?? 0) * KIB
  };
};
var parseMemoryPressure = (text) => {
  const match = /^some\s+.*?avg10=(\d+(?:\.\d+)?)/m.exec(text);
  const percent = match?.[1] ? Number(match[1]) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    return null;
  return percent >= 10 ? "high" : percent >= 1 ? "medium" : "low";
};
var parseCgroupMemory = (input) => {
  const limitText = input.limit?.trim();
  const usageText = input.usage?.trim();
  if (!limitText || !usageText || limitText === "max")
    return null;
  const limit = Number(limitText);
  const usage = Number(usageText);
  if (!Number.isFinite(limit) || !Number.isFinite(usage) || limit <= 0 || limit >= 2 ** 60)
    return null;
  const inactive = input.stat ? field(input.stat, /^(?:total_)?inactive_file (\d+)$/m) ?? 0 : 0;
  return { used: Math.min(limit, Math.max(0, usage - inactive)), total: limit };
};

// src/service/collectors/windows.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
var systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
var POWERSHELL = [`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "powershell.exe"];
var NVIDIA_SMI_WIN32 = ["nvidia-smi.exe", `${systemRoot}\\System32\\nvidia-smi.exe`];
var POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
var powerShellEnv = (source = process.env) => {
  const hasModulePath = Object.keys(source).some((name) => name.toUpperCase() === "PSMODULEPATH");
  return hasModulePath ? source : { ...source, PSModulePath: "" };
};
var runPowerShell = (script, timeout) => run(POWERSHELL, [...POWERSHELL_ARGS, script], timeout, powerShellEnv());
var gpuLoopScript = (parentPid) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
  $e = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE '%engtype_3D'" | Select-Object Name, UtilizationPercentage)
  $m = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name, DedicatedUsage, DedicatedLimit, SharedUsage, SharedLimit)
  [Console]::Out.WriteLine((@{ engines = $e; memory = $m } | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;
var createGpuLoop = () => {
  let child = null;
  let line = null;
  let missing = false;
  let waiters = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending)
      resolve();
  };
  const start = (candidates) => {
    const [command, ...rest] = candidates;
    if (!command) {
      missing = true;
      wake();
      return;
    }
    const proc = spawn(command, [...POWERSHELL_ARGS, gpuLoopScript(process.pid)], {
      env: powerShellEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    child = proc;
    proc.once("error", (error) => {
      if (child !== proc)
        return;
      child = null;
      if ("code" in error && error.code === "ENOENT")
        start(rest);
      else
        wake();
    });
    proc.once("exit", () => {
      if (child === proc)
        child = null;
      wake();
    });
    if (proc.stdout) {
      createInterface({ input: proc.stdout }).on("line", (next) => {
        if (!next.trim().startsWith("{"))
          return;
        line = next;
        wake();
      });
    }
  };
  return {
    latest: async (waitMs) => {
      if (missing)
        return { missing: true };
      if (!child) {
        line = null;
        start(POWERSHELL);
      }
      if (line === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(done);
        });
      }
      if (missing)
        return { missing: true };
      return line === null ? { missing: false } : { line };
    },
    stop: () => {
      const proc = child;
      child = null;
      line = null;
      proc?.kill();
    }
  };
};

// src/service/collectors/parse-cpu.ts
var clampPercent = (value) => Math.min(100, Math.max(0, value));
var parseCpuFrequencyMHz = (readings) => {
  const values = readings.map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length / 1000;
};
var cpuUsage = (previous, next) => {
  if (previous.length === 0 || previous.length !== next.length)
    return null;
  let busyAll = 0;
  let totalAll = 0;
  const perCore = [];
  for (let index = 0;index < next.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (!before || !after)
      return null;
    const busy = after.user - before.user + (after.nice - before.nice) + (after.sys - before.sys) + (after.irq - before.irq);
    const total = busy + (after.idle - before.idle);
    busyAll += busy;
    totalAll += total;
    perCore.push(total > 0 ? clampPercent(busy / total * 100) : 0);
  }
  if (totalAll <= 0)
    return null;
  return { total: clampPercent(busyAll / totalAll * 100), perCore };
};
var parseCpuMax = (text) => {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  if (!quota || !period || quota === "max")
    return null;
  const cores = Number(quota) / Number(period);
  return Number.isFinite(cores) && cores > 0 ? cores : null;
};
var parseCfsQuota = (quota, period) => {
  const quotaValue = Number((quota ?? "").trim());
  const periodValue = Number((period ?? "").trim());
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || quotaValue <= 0 || periodValue <= 0)
    return null;
  return quotaValue / periodValue;
};
var parseCpuStatUsage = (text) => {
  const match = /^usage_usec (\d+)$/m.exec(text ?? "");
  return match?.[1] ? Number(match[1]) : null;
};
var limitedCpuUsage = (previousUsec, nextUsec, elapsedMs, limitCores) => {
  if (elapsedMs <= 0 || limitCores <= 0 || nextUsec < previousUsec)
    return null;
  const usedMs = (nextUsec - previousUsec) / 1000;
  return clampPercent(usedMs / (elapsedMs * limitCores) * 100);
};

// src/service/collectors/cpu-mem.ts
var CGROUP = "/sys/fs/cgroup";
var SWAP_INTERVAL_MS = 1e4;
var WINDOWS_PAGEFILE_QUERY = "Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize, CurrentUsage | ConvertTo-Json -Compress";
var readLinuxFrequencyMHz = async () => {
  let entries;
  try {
    entries = await readdir("/sys/devices/system/cpu");
  } catch {
    return null;
  }
  const cores = entries.filter((name) => /^cpu\d+$/.test(name)).slice(0, 256);
  const values = await Promise.all(cores.map(async (core) => await readText(`/sys/devices/system/cpu/${core}/cpufreq/scaling_cur_freq`) ?? await readText(`/sys/devices/system/cpu/${core}/cpufreq/cpuinfo_cur_freq`)));
  return parseCpuFrequencyMHz(values.filter((value) => value !== null));
};
var readCgroupCpu = async () => {
  const v2Limit = await readText(`${CGROUP}/cpu.max`);
  if (v2Limit !== null) {
    return { limitCores: parseCpuMax(v2Limit), usageUsec: parseCpuStatUsage(await readText(`${CGROUP}/cpu.stat`)) };
  }
  for (const dir of ["cpu,cpuacct", "cpu"]) {
    const quota = await readText(`${CGROUP}/${dir}/cpu.cfs_quota_us`);
    if (quota === null)
      continue;
    const limitCores = parseCfsQuota(quota, await readText(`${CGROUP}/${dir}/cpu.cfs_period_us`));
    const usageNs = Number((await readText(`${CGROUP}/${dir}/cpuacct.usage`) ?? await readText(`${CGROUP}/cpuacct/cpuacct.usage`) ?? "").trim());
    return { limitCores, usageUsec: Number.isFinite(usageNs) && usageNs > 0 ? usageNs / 1000 : null };
  }
  return { limitCores: null, usageUsec: null };
};
var readCgroupMemory = async () => {
  const v2 = parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory.max`),
    usage: await readText(`${CGROUP}/memory.current`),
    stat: await readText(`${CGROUP}/memory.stat`)
  });
  if (v2)
    return v2;
  return parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory/memory.limit_in_bytes`),
    usage: await readText(`${CGROUP}/memory/memory.usage_in_bytes`),
    stat: await readText(`${CGROUP}/memory/memory.stat`)
  });
};
var createCpuMemCollector = (platform, container, now) => {
  let previousTimes = [];
  let previousCgroup = null;
  let swap = null;
  let windowsPageFile = null;
  const readSwap = async () => {
    const at = now();
    if (swap && at - swap.at < SWAP_INTERVAL_MS)
      return swap.value;
    const result = await run(["/usr/sbin/sysctl", "sysctl"], ["vm.swapusage"]);
    swap = { value: result.ok ? parseSwapUsage(result.stdout) : null, at };
    return swap.value;
  };
  const readWindowsPageFile = async () => {
    const at = now();
    if (windowsPageFile && at - windowsPageFile.at < SWAP_INTERVAL_MS)
      return windowsPageFile.value;
    const result = await runPowerShell(WINDOWS_PAGEFILE_QUERY, 5000);
    const value = result.ok ? parseWindowsPageFile(result.stdout) : null;
    windowsPageFile = { value, at };
    return value;
  };
  const readCgroupBaseline = async () => {
    if (!container)
      return;
    const { usageUsec } = await readCgroupCpu();
    previousCgroup = usageUsec === null ? null : { usageUsec, at: now() };
  };
  return {
    prime: async () => {
      previousTimes = os.cpus().map((cpu) => cpu.times);
      await readCgroupBaseline();
    },
    cpu: async () => {
      const cpuData = os.cpus();
      const times = cpuData.map((cpu) => cpu.times);
      const host = cpuUsage(previousTimes, times);
      previousTimes = times;
      const load = platform === "win32" ? null : os.loadavg();
      const base = {
        cores: times.length,
        model: cpuData[0]?.model.trim() || null,
        load: load ? [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] : null,
        frequencyMHz: platform === "linux" ? await readLinuxFrequencyMHz() : null
      };
      if (container) {
        const { limitCores, usageUsec } = await readCgroupCpu();
        const before = previousCgroup;
        const at = now();
        previousCgroup = usageUsec === null ? null : { usageUsec, at };
        if (limitCores !== null) {
          const total = before && usageUsec !== null ? limitedCpuUsage(before.usageUsec, usageUsec, at - before.at, limitCores) : null;
          if (total === null)
            return unavailable("failed");
          return { status: "ok", total, perCore: [], limitCores, ...base };
        }
      }
      if (!host)
        return unavailable("failed");
      return { status: "ok", total: host.total, perCore: host.perCore, limitCores: null, ...base };
    },
    memory: async () => {
      if (container) {
        const limited = await readCgroupMemory();
        if (limited)
          return {
            status: "ok",
            used: limited.used,
            total: limited.total,
            available: Math.max(0, limited.total - limited.used),
            cached: null,
            committed: null,
            commitLimit: null,
            pressure: null,
            swapUsed: null,
            swapTotal: null
          };
      }
      if (platform === "linux") {
        const info = parseMeminfo(await readText("/proc/meminfo") ?? "");
        if (!info)
          return unavailable("failed");
        return {
          status: "ok",
          used: info.total - info.available,
          total: info.total,
          available: info.available,
          cached: info.cached,
          committed: info.committed,
          commitLimit: info.commitLimit,
          pressure: parseMemoryPressure(await readText(container ? `${CGROUP}/memory.pressure` : "/proc/pressure/memory") ?? ""),
          swapUsed: info.swapTotal > 0 ? info.swapTotal - info.swapFree : null,
          swapTotal: info.swapTotal > 0 ? info.swapTotal : null
        };
      }
      if (platform === "darwin") {
        const [vm, swapUsage] = await Promise.all([run(["/usr/bin/vm_stat", "vm_stat"], []), readSwap()]);
        if (!vm.ok)
          return unavailable(vm.missing ? "tool-missing" : "failed", "vm_stat");
        const used = parseVmStat(vm.stdout);
        if (used === null)
          return unavailable("failed");
        return {
          status: "ok",
          used,
          total: os.totalmem(),
          available: Math.max(0, os.totalmem() - used),
          cached: null,
          committed: null,
          commitLimit: null,
          pressure: null,
          swapUsed: swapUsage && swapUsage.total > 0 ? swapUsage.used : null,
          swapTotal: swapUsage && swapUsage.total > 0 ? swapUsage.total : null
        };
      }
      const total = os.totalmem();
      const used = total - os.freemem();
      const pageFile = platform === "win32" ? await readWindowsPageFile() : null;
      return {
        status: "ok",
        used,
        total,
        available: total - used,
        cached: null,
        committed: null,
        commitLimit: null,
        pressure: null,
        swapUsed: pageFile?.used ?? null,
        swapTotal: pageFile?.total ?? null
      };
    }
  };
};

// src/service/collectors/battery.ts
import { readdir as readdir2 } from "node:fs/promises";

// src/service/collectors/parse-battery.ts
var number = (value) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
var capacityHealth = (full, design) => {
  const fullValue = number(full);
  const designValue = number(design);
  return fullValue !== null && designValue !== null && designValue > 0 ? Math.min(100, fullValue / designValue * 100) : null;
};
var parseLinuxBattery = (input) => {
  const percent = number(input.capacity);
  if (percent === null || percent > 100)
    return null;
  const stateText = input.status?.trim().toLowerCase();
  const state = stateText === "charging" ? "charging" : stateText === "discharging" ? "discharging" : stateText === "full" ? "full" : "unknown";
  const energyNow = number(input.energyNow);
  const energyFull = number(input.energyFull);
  const healthPercent = capacityHealth(input.energyFull, input.energyFullDesign);
  const powerNow = number(input.powerNow);
  const remainingEnergy = state === "charging" && energyFull !== null && energyNow !== null ? Math.max(0, energyFull - energyNow) : energyNow;
  const remainingSeconds = powerNow !== null && powerNow > 0 && remainingEnergy !== null ? Math.round(remainingEnergy / powerNow * 3600) : null;
  const ac = input.acOnline?.trim();
  return {
    status: "ok",
    percent,
    state,
    acConnected: ac === "1" ? true : ac === "0" ? false : null,
    remainingSeconds,
    healthPercent
  };
};
var parseWindowsBattery = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null)
    return null;
  const get = (key) => Reflect.get(row, key);
  const percent = number(get("EstimatedChargeRemaining"));
  const batteryStatus = number(get("BatteryStatus"));
  if (percent === null || percent > 100)
    return null;
  const state = batteryStatus === 3 ? "full" : batteryStatus !== null && [6, 7, 8, 9, 10, 11, 12].includes(batteryStatus) ? "charging" : batteryStatus === 1 || batteryStatus === 4 || batteryStatus === 5 ? "discharging" : "unknown";
  const runtimeMinutes = number(get("EstimatedRunTime"));
  const remainingSeconds = runtimeMinutes !== null && runtimeMinutes > 0 && runtimeMinutes < 71582788 ? runtimeMinutes * 60 : null;
  return {
    status: "ok",
    percent,
    state,
    acConnected: batteryStatus === null ? null : [2, 3, 6, 7, 8, 9, 10, 11, 12, 14].includes(batteryStatus),
    remainingSeconds,
    healthPercent: capacityHealth(get("FullChargeCapacity"), get("DesignCapacity"))
  };
};
var parseDarwinBattery = (text) => {
  const header = /Now drawing from ['"]([^'"]+)['"]/.exec(text);
  const line = /([0-9]{1,3})%;\s*([^\n]*)/i.exec(text);
  if (!line?.[1])
    return null;
  const percent = Number(line[1]);
  if (!Number.isFinite(percent) || percent > 100)
    return null;
  const stateText = line[2]?.toLowerCase() ?? "";
  const state = /\bcharging\b|\bfinishing charge\b/i.test(stateText) ? "charging" : /\bdischarging\b/i.test(stateText) ? "discharging" : /\bcharged\b/i.test(stateText) ? "full" : "unknown";
  const remaining = /\((\d+):(\d+)\s+remaining\)/i.exec(stateText);
  const hours = remaining?.[1] === undefined ? null : Number(remaining[1]);
  const minutes = remaining?.[2] === undefined ? null : Number(remaining[2]);
  return {
    status: "ok",
    percent,
    state,
    acConnected: header?.[1] === "AC Power" ? true : header?.[1] === "Battery Power" ? false : null,
    remainingSeconds: hours !== null && minutes !== null ? (hours * 60 + minutes) * 60 : null,
    healthPercent: null
  };
};

// src/service/collectors/battery.ts
var WINDOWS_BATTERY = `
$ErrorActionPreference = 'Stop'
try {
  $batteries = @(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime, FullChargeCapacity, DesignCapacity)
  if ($batteries.Count -eq 0) { [Console]::Out.WriteLine('[]') }
  else { ConvertTo-Json -InputObject $batteries -Compress }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
var linuxBattery = async () => {
  let devices;
  try {
    devices = await readdir2("/sys/class/power_supply");
  } catch {
    return unavailable("failed");
  }
  let acOnline = null;
  const candidates = [];
  for (const device of devices.slice(0, 64)) {
    const path = `/sys/class/power_supply/${device}`;
    const [type, online] = await Promise.all([readText(`${path}/type`), readText(`${path}/online`)]);
    if (type?.trim() === "Battery")
      candidates.push(path);
    if (online?.trim() === "1" || online?.trim() === "0")
      acOnline = online.trim();
  }
  const path = candidates[0];
  if (!path)
    return unavailable("no-device");
  const [capacity, status, energyNow, energyFull, energyFullDesign, powerNow] = await Promise.all([
    readText(`${path}/capacity`),
    readText(`${path}/status`),
    readText(`${path}/energy_now`),
    readText(`${path}/energy_full`),
    readText(`${path}/energy_full_design`),
    readText(`${path}/power_now`)
  ]);
  const result = parseLinuxBattery({ capacity, status, energyNow, energyFull, energyFullDesign, powerNow, acOnline });
  return result ?? unavailable("failed");
};
var readBattery = async (platform) => {
  if (platform === "linux")
    return linuxBattery();
  if (platform === "darwin") {
    const result = await run(["/usr/bin/pmset", "pmset"], ["-g", "batt"]);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "pmset");
    return parseDarwinBattery(result.stdout) ?? unavailable("no-device");
  }
  if (platform === "win32") {
    const result = await runPowerShell(WINDOWS_BATTERY, 8000);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
    const value = parseWindowsBattery(result.stdout);
    const output = result.stdout.trim();
    return value ?? (output === "[]" ? unavailable("no-device") : unavailable("failed"));
  }
  return unavailable("unsupported");
};

// src/service/collectors/computer.ts
import os2 from "node:os";
var WINDOWS_COMPUTER_INFO = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer, Product
$cpu = @(Get-CimInstance Win32_Processor | Select-Object NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
$ram = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Speed)
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
$displayVersion = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).DisplayVersion
@{
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  firmware = $bios.SMBIOSBIOSVersion
  motherboard = if ($board.Manufacturer -or $board.Product) { "$($board.Manufacturer) $($board.Product)".Trim() } else { $null }
  osName = $os.Caption
  osVersion = $os.Version
  osDisplayVersion = $displayVersion
  osBuild = $os.BuildNumber
  displayAdapters = @($gpu | ForEach-Object { if ($_.Name) { if ($_.DriverVersion) { "$($_.Name) · $($_.DriverVersion)" } else { $_.Name } } })
  physicalCores = [int](($cpu | Measure-Object NumberOfCores -Sum).Sum)
  logicalProcessors = [int](($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
  cpuMaxMHz = [int](($cpu | Measure-Object MaxClockSpeed -Maximum).Maximum)
  memoryModules = $ram.Count
  memorySpeedMHz = if ($ram.Count -gt 0) { [int](($ram | Measure-Object Speed -Average).Average) } else { $null }
} | ConvertTo-Json -Compress
`;
var numberOrNull = (value) => {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
};
var stringOrNull = (value) => typeof value === "string" && value.trim() && !/^to be filled by o\.e\.m\.?$/i.test(value.trim()) ? value.trim() : null;
var parseComputerInfo = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const read = (key) => Reflect.get(value, key);
  return {
    manufacturer: stringOrNull(read("manufacturer")),
    model: stringOrNull(read("model")),
    firmware: stringOrNull(read("firmware")),
    osName: stringOrNull(read("osName")),
    osVersion: stringOrNull(read("osVersion")),
    osDisplayVersion: stringOrNull(read("osDisplayVersion")),
    osBuild: stringOrNull(read("osBuild")),
    displayAdapters: Array.isArray(read("displayAdapters")) ? read("displayAdapters").filter((item) => typeof item === "string" && item.trim().length > 0) : [],
    physicalCores: numberOrNull(read("physicalCores")),
    logicalProcessors: numberOrNull(read("logicalProcessors")),
    cpuMaxMHz: numberOrNull(read("cpuMaxMHz")),
    memoryModules: numberOrNull(read("memoryModules")),
    memorySpeedMHz: numberOrNull(read("memorySpeedMHz")),
    motherboard: stringOrNull(read("motherboard"))
  };
};
var parseReleaseFile = (text) => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match?.[1] || match[2] === undefined)
    return [];
  return [[match[1], match[2].replace(/^"|"$/g, "")]];
}));
var readLinuxInfo = async () => {
  const [dmi, release, cpuInfo, maxFrequency] = await Promise.all([
    Promise.all(["sys_vendor", "product_name", "bios_version", "board_vendor", "board_name"].map((name) => readText(`/sys/class/dmi/id/${name}`))),
    readText("/etc/os-release"),
    readText("/proc/cpuinfo"),
    readText("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
  ]);
  const [manufacturer, model, firmware, boardVendor, boardName] = dmi;
  const coreIds = new Set;
  for (const block of (cpuInfo ?? "").split(/\n\s*\n/)) {
    const physical = /^physical id\s*:\s*(\S+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\S+)/m.exec(block)?.[1];
    if (physical && core)
      coreIds.add(`${physical}:${core}`);
  }
  const frequencyKHz = Number(maxFrequency?.trim());
  const osRelease = parseReleaseFile(release ?? "");
  const displayAdapters = [];
  return {
    manufacturer: stringOrNull(manufacturer),
    model: stringOrNull(model),
    firmware: stringOrNull(firmware),
    osName: osRelease.NAME || "Linux",
    osVersion: os2.release(),
    osDisplayVersion: osRelease.PRETTY_NAME || null,
    osBuild: os2.release() || null,
    displayAdapters,
    physicalCores: coreIds.size || null,
    logicalProcessors: os2.cpus().length || null,
    cpuMaxMHz: Number.isFinite(frequencyKHz) && frequencyKHz > 0 ? Math.round(frequencyKHz / 1000) : null,
    memoryModules: null,
    memorySpeedMHz: null,
    motherboard: [stringOrNull(boardVendor), stringOrNull(boardName)].filter(Boolean).join(" ") || null
  };
};
var readDarwinInfo = async () => {
  const [hardware, version, build] = await Promise.all([
    run(["/usr/sbin/sysctl", "sysctl"], ["-n", "hw.model", "hw.physicalcpu", "hw.logicalcpu", "hw.cpufrequency_max"]),
    run(["/usr/bin/sw_vers", "sw_vers"], ["-productVersion"]),
    run(["/usr/bin/sw_vers", "sw_vers"], ["-buildVersion"])
  ]);
  if (!hardware.ok)
    return unavailable(hardware.missing ? "tool-missing" : "failed", "sysctl");
  const values = hardware.stdout.trim().split(/\r?\n/);
  const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const frequencyHz = toNumber(values[3]);
  return {
    manufacturer: "Apple",
    model: values[0]?.trim() || null,
    firmware: null,
    osName: "macOS",
    osVersion: version.ok ? version.stdout.trim() || null : os2.release(),
    osDisplayVersion: version.ok ? version.stdout.trim() || null : null,
    osBuild: build.ok ? build.stdout.trim() || null : null,
    displayAdapters: [],
    physicalCores: toNumber(values[1]),
    logicalProcessors: toNumber(values[2]),
    cpuMaxMHz: frequencyHz === null ? null : Math.round(frequencyHz / 1e6),
    memoryModules: null,
    memorySpeedMHz: null,
    motherboard: null
  };
};
var readComputerInfo = async (platform) => {
  if (platform === "linux")
    return readLinuxInfo();
  if (platform === "darwin")
    return readDarwinInfo();
  if (platform === "win32") {
    const result = await runPowerShell(WINDOWS_COMPUTER_INFO, 1e4);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
    return parseComputerInfo(result.stdout) ?? unavailable("failed");
  }
  return unavailable("unsupported");
};

// src/service/collectors/parse-disks.ts
var KIB2 = 1024;
var parseDf = (text) => {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[5])
      continue;
    rows.push({
      filesystem: match[1],
      size: Number(match[2]) * KIB2,
      used: Number(match[3]) * KIB2,
      available: Number(match[4]) * KIB2,
      mount: match[5]
    });
  }
  return rows;
};
var DARWIN_HIDDEN = /^\/(System\/Volumes\/(?!Data$)|Volumes\/Recovery$|private\/var\/vm$|Library\/Developer\/CoreSimulator\/)/;
var darwinDisks = (rows) => {
  const containers = new Map;
  for (const row of rows) {
    if (!row.filesystem.startsWith("/dev/") || DARWIN_HIDDEN.test(row.mount) || row.size <= 0)
      continue;
    const key = `${row.size}:${row.available}`;
    const entry = containers.get(key) ?? { mounts: [], size: row.size, available: row.available };
    entry.mounts.push(row.mount);
    containers.set(key, entry);
  }
  return [...containers.values()].map((entry) => {
    const mount = entry.mounts.includes("/") ? "/" : entry.mounts.sort((a, b) => a.length - b.length)[0] ?? "/";
    const label = mount.startsWith("/Volumes/") ? mount.slice("/Volumes/".length) || null : null;
    return { mount, label, used: entry.size - entry.available, total: entry.size };
  }).sort(byMount);
};
var LINUX_HIDDEN_MOUNT = /^\/(proc|sys|dev|run|snap)(\/|$)|^\/etc\//;
var linuxDisks = (rows, container) => {
  const byDevice = new Map;
  for (const row of rows) {
    const real = row.filesystem.startsWith("/dev/") && !row.filesystem.startsWith("/dev/loop");
    const containerRoot = container && row.mount === "/";
    if (!(real || containerRoot) || LINUX_HIDDEN_MOUNT.test(row.mount) || row.size <= 0)
      continue;
    const existing = byDevice.get(row.filesystem);
    if (!existing || row.mount.length < existing.mount.length)
      byDevice.set(row.filesystem, row);
  }
  const byFigures = new Map;
  for (const row of byDevice.values()) {
    const key = `${row.size}:${row.used}:${row.available}`;
    const existing = byFigures.get(key);
    if (!existing || row.mount === "/" || existing.mount !== "/" && row.mount.length < existing.mount.length) {
      byFigures.set(key, row);
    }
  }
  return [...byFigures.values()].map((row) => ({ mount: row.mount, label: null, used: row.used, total: row.used + row.available, device: row.filesystem })).sort(byMount);
};
var parseWindowsDisks = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const disks = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null)
      continue;
    const mount = Reflect.get(row, "DeviceID");
    const label = Reflect.get(row, "VolumeName");
    const size = Number(Reflect.get(row, "Size"));
    const free = Number(Reflect.get(row, "FreeSpace"));
    if (typeof mount !== "string" || !Number.isFinite(size) || !Number.isFinite(free) || size <= 0)
      continue;
    const fileSystem = Reflect.get(row, "FileSystem");
    const driveType = Number(Reflect.get(row, "DriveType"));
    disks.push({
      mount,
      label: typeof label === "string" && label.trim() ? label.trim() : null,
      used: size - free,
      total: size,
      device: mount,
      ...typeof fileSystem === "string" && fileSystem.trim() ? { fileSystem: fileSystem.trim() } : {},
      ...driveType === 2 ? { driveType: "removable" } : driveType === 3 ? { driveType: "fixed" } : driveType === 4 ? { driveType: "network" } : {}
    });
  }
  return disks.sort(byMount);
};
function byMount(left, right) {
  if (left.mount === "/")
    return -1;
  if (right.mount === "/")
    return 1;
  return left.mount.localeCompare(right.mount);
}

// src/service/collectors/disks.ts
var WINDOWS_DISKS = 'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3 OR DriveType=4" | Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem, DriveType | ConvertTo-Json -Compress';
var WINDOWS_TIMEOUT_MS = 1e4;
var DF = ["/bin/df", "/usr/bin/df", "df"];
var deviceType = async (disk) => {
  if (!disk.device?.startsWith("/dev/"))
    return disk;
  const block = disk.device.slice("/dev/".length);
  if (/^(mapper|disk|loop)/.test(block))
    return disk;
  const queueBlock = block.replace(/p\d+$/, "");
  const rotationalBlock = /^(nvme\d+n\d+|mmcblk\d+)$/.test(queueBlock) ? queueBlock : queueBlock.replace(/\d+$/, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(rotationalBlock))
    return disk;
  const rotational = (await readText(`/sys/class/block/${rotationalBlock}/queue/rotational`))?.trim();
  if (rotational === "1")
    return { ...disk, deviceType: "hdd" };
  if (rotational === "0")
    return { ...disk, deviceType: /^nvme/.test(rotationalBlock) ? "nvme" : "ssd" };
  return disk;
};
var readDf = async () => {
  const local = await run(DF, ["-kPl"]);
  if (local.ok)
    return local;
  const all = await run(DF, ["-kP"]);
  if (all.ok)
    return all;
  return unavailable(all.missing ? "tool-missing" : "failed", "df");
};
var readDisks = async (platform, container) => {
  if (platform === "win32") {
    const result = await runPowerShell(WINDOWS_DISKS, WINDOWS_TIMEOUT_MS);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
    return parseWindowsDisks(result.stdout) ?? unavailable("failed");
  }
  if (platform === "darwin" || platform === "linux") {
    const df = await readDf();
    if (!("ok" in df))
      return df;
    const rows = parseDf(df.stdout);
    if (rows.length === 0)
      return unavailable("failed");
    if (platform === "darwin")
      return darwinDisks(rows);
    return Promise.all(linuxDisks(rows, container).map(deviceType));
  }
  return unavailable("unsupported");
};

// src/service/collectors/parse-disk-activity.ts
var nonNegative = (value) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
var parseProcDiskStats = (text) => text.split(/\r?\n/).flatMap((line) => {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 14 || !fields[2])
    return [];
  const values = [3, 5, 6, 7, 9, 10, 12].map((index) => nonNegative(fields[index]));
  if (values.some((value) => value === null))
    return [];
  if (values.some((value) => value === null))
    return [];
  return [{
    device: fields[2],
    reads: values[0],
    readSectors: values[1],
    readMs: values[2],
    writes: values[3],
    writeSectors: values[4],
    writeMs: values[5],
    busyMs: values[6]
  }];
});
var diskActivityFromDelta = (current, previous, elapsedMs) => current.map((entry) => {
  const before = previous?.find((item) => item.device === entry.device);
  const deltas = before ? {
    readSectors: entry.readSectors - before.readSectors,
    writeSectors: entry.writeSectors - before.writeSectors,
    reads: entry.reads - before.reads,
    writes: entry.writes - before.writes,
    readMs: entry.readMs - before.readMs,
    writeMs: entry.writeMs - before.writeMs,
    busyMs: entry.busyMs - before.busyMs
  } : null;
  const valid = deltas !== null && elapsedMs > 0 && Object.values(deltas).every((value) => value >= 0);
  const readOps = valid ? deltas.reads : null;
  const writeOps = valid ? deltas.writes : null;
  const totalOps = readOps !== null && writeOps !== null ? readOps + writeOps : 0;
  return {
    device: entry.device,
    readBytesPerSecond: valid ? deltas.readSectors * 512 * 1000 / elapsedMs : null,
    writeBytesPerSecond: valid ? deltas.writeSectors * 512 * 1000 / elapsedMs : null,
    readIops: valid ? readOps * 1000 / elapsedMs : null,
    writeIops: valid ? writeOps * 1000 / elapsedMs : null,
    activePercent: valid ? Math.min(100, deltas.busyMs * 100 / elapsedMs) : null,
    responseMs: valid && totalOps > 0 ? (deltas.readMs + deltas.writeMs) / totalOps : null
  };
});
var parseWindowsDiskActivity = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const output = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null)
      continue;
    const device = Reflect.get(row, "Name");
    if (typeof device !== "string" || !/^[A-Z]:$/i.test(device))
      continue;
    const read = nonNegative(Reflect.get(row, "DiskReadBytesPersec"));
    const write = nonNegative(Reflect.get(row, "DiskWriteBytesPersec"));
    const readIops = nonNegative(Reflect.get(row, "DiskReadsPersec"));
    const writeIops = nonNegative(Reflect.get(row, "DiskWritesPersec"));
    const active = nonNegative(Reflect.get(row, "PercentDiskTime"));
    const readLatency = nonNegative(Reflect.get(row, "AvgDisksecPerRead"));
    const writeLatency = nonNegative(Reflect.get(row, "AvgDisksecPerWrite"));
    const latencies = [readLatency, writeLatency].filter((value) => value !== null);
    output.push({
      device,
      readBytesPerSecond: read,
      writeBytesPerSecond: write,
      readIops,
      writeIops,
      activePercent: active === null ? null : Math.min(100, active),
      responseMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length * 1000 : null
    });
  }
  return output;
};

// src/service/collectors/disk-activity.ts
var WINDOWS_DISK_ACTIVITY = `
$ErrorActionPreference = 'SilentlyContinue'
@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object { $_.Name -match '^[A-Z]:$' } | Select-Object Name, DiskReadBytesPersec, DiskWriteBytesPersec, DiskReadsPersec, DiskWritesPersec, PercentDiskTime, AvgDisksecPerRead, AvgDisksecPerWrite) | ConvertTo-Json -Compress
`;
var createDiskActivityCollector = (platform, now) => {
  let previous = null;
  let previousAt = null;
  return async () => {
    const sampledAt = now();
    if (platform === "linux") {
      const text = await readText("/proc/diskstats");
      if (text === null)
        return unavailable("failed");
      const current = parseProcDiskStats(text);
      const items = diskActivityFromDelta(current, previous, previousAt === null ? 0 : sampledAt - previousAt);
      previous = current;
      previousAt = sampledAt;
      return items.length > 0 ? { status: "ok", items, sampledAt } : unavailable("no-device");
    }
    if (platform === "win32") {
      const result = await runPowerShell(WINDOWS_DISK_ACTIVITY, 8000);
      if (!result.ok)
        return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
      const items = parseWindowsDiskActivity(result.stdout);
      if (items === null)
        return unavailable("failed");
      return items.length > 0 ? { status: "ok", items, sampledAt } : unavailable("no-device");
    }
    return unavailable(platform === "darwin" ? "unsupported" : "unsupported");
  };
};

// src/service/collectors/gpu.ts
import { readdir as readdir3 } from "node:fs/promises";

// src/service/collectors/parse-gpu.ts
var MIB2 = 1024 * 1024;
var percent = (value) => value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));
var numberOrNull2 = (text) => {
  if (text === undefined)
    return null;
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
};
var parseIoreg = (text) => {
  const devices = [];
  for (const block of text.split(/^\+-o /m).slice(1)) {
    const stats = /"PerformanceStatistics" = \{([^}]*)\}/.exec(block)?.[1];
    if (stats === undefined)
      continue;
    const read = (key) => {
      const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\%]/g, "\\$&")}"=(\\d+)`).exec(stats);
      return match?.[1] ? Number(match[1]) : null;
    };
    const model = /"model" = (?:"([^"]+)"|<"([^"]+)">)/.exec(block);
    const className = /^(\S+)/.exec(block)?.[1] ?? "GPU";
    devices.push({
      name: model?.[1] ?? model?.[2] ?? className,
      utilization: percent(read("Device Utilization %") ?? read("GPU Activity(%)")),
      memUsed: read("In use system memory") ?? read("vramUsedBytes"),
      memTotal: null
    });
  }
  return devices;
};
var parseNvidiaSmi = (text) => {
  const devices = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim())
      continue;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 4)
      continue;
    const extended = parts.length >= 9;
    const columns = extended ? parts.slice(-8) : parts.slice(-3);
    const name = parts.slice(0, parts.length - columns.length).join(", ") || "NVIDIA GPU";
    const [utilizationText, usedText, totalText, temperatureText, frequencyText, powerText, fanText, driverText] = columns;
    const utilization = numberOrNull2(utilizationText);
    const used = numberOrNull2(usedText);
    const total = numberOrNull2(totalText);
    devices.push({
      name,
      utilization: percent(utilization),
      memUsed: used === null ? null : used * MIB2,
      memTotal: total === null ? null : total * MIB2,
      ...extended ? {
        temperatureC: numberOrNull2(temperatureText),
        frequencyMHz: numberOrNull2(frequencyText),
        powerW: numberOrNull2(powerText),
        fanPercent: numberOrNull2(fanText),
        driverVersion: driverText && driverText !== "N/A" ? driverText : null
      } : {}
    });
  }
  return devices;
};
var parseAmdCards = (cards) => cards.filter((card) => card.vendor?.trim() === "0x1002" && card.busy !== null).map((card) => ({
  name: `AMD GPU (${card.card})`,
  utilization: percent(numberOrNull2(card.busy ?? undefined)),
  memUsed: numberOrNull2(card.vramUsed ?? undefined),
  memTotal: numberOrNull2(card.vramTotal ?? undefined)
}));
var asArray = (value) => {
  if (Array.isArray(value))
    return value;
  return value === null || value === undefined ? [] : [value];
};
var LUID = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i;
var toNumber = (value) => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (typeof value === "string")
    return numberOrNull2(value);
  return null;
};
var toName = (value) => typeof value === "string" ? value : null;
var parseWindowsGpu = (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null)
    return null;
  const record = (value, key) => typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const luidOf = (value) => LUID.exec(toName(record(value, "Name")) ?? "")?.[1]?.toLowerCase() ?? null;
  const adapters = new Map;
  for (const engine of asArray(record(parsed, "engines"))) {
    const luid = luidOf(engine);
    const value = toNumber(record(engine, "UtilizationPercentage"));
    if (!luid || value === null)
      continue;
    const entry = adapters.get(luid) ?? { utilization: 0, memUsed: null, memBudget: null, sharedMemUsed: null, sharedMemTotal: null };
    entry.utilization += value;
    adapters.set(luid, entry);
  }
  for (const row of asArray(record(parsed, "memory"))) {
    const luid = luidOf(row);
    const value = toNumber(record(row, "DedicatedUsage"));
    const budget = toNumber(record(row, "DedicatedLimit"));
    const sharedUsed = toNumber(record(row, "SharedUsage"));
    const sharedBudget = toNumber(record(row, "SharedLimit"));
    const entry = luid ? adapters.get(luid) : undefined;
    if (!entry)
      continue;
    if (value !== null)
      entry.memUsed = (entry.memUsed ?? 0) + value;
    if (budget !== null)
      entry.memBudget = (entry.memBudget ?? 0) + budget;
    if (sharedUsed !== null)
      entry.sharedMemUsed = (entry.sharedMemUsed ?? 0) + sharedUsed;
    if (sharedBudget !== null)
      entry.sharedMemTotal = (entry.sharedMemTotal ?? 0) + sharedBudget;
  }
  const devices = [...adapters.entries()].sort(([left], [right]) => left.localeCompare(right));
  return devices.map(([, entry], index) => ({
    name: devices.length === 1 ? "GPU" : `GPU ${index + 1}`,
    utilization: percent(entry.utilization),
    memUsed: entry.memUsed,
    memTotal: null,
    ...entry.memBudget === null ? {} : { memBudget: entry.memBudget },
    ...entry.sharedMemUsed === null ? {} : { sharedMemUsed: entry.sharedMemUsed },
    ...entry.sharedMemTotal === null ? {} : { sharedMemTotal: entry.sharedMemTotal }
  }));
};

// src/service/collectors/gpu.ts
var NVIDIA_ARGS = ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.gr,power.draw,fan.speed,driver_version", "--format=csv,noheader,nounits"];
var NVIDIA_BASIC_ARGS = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"];
var WINDOWS_FIRST_SAMPLE_MS = 8000;
var found = (devices) => devices.length > 0 ? { status: "ok", devices } : unavailable("no-device");
var readNvidia = async (commands) => {
  const result = await run(commands, NVIDIA_ARGS);
  if (result.ok)
    return { devices: parseNvidiaSmi(result.stdout) };
  if (result.missing)
    return { missing: true };
  const basic = await run(commands, NVIDIA_BASIC_ARGS);
  if (!basic.ok)
    return { missing: basic.missing };
  return { devices: parseNvidiaSmi(basic.stdout) };
};
var readAmdCards = async () => {
  const entries = await readdir3("/sys/class/drm").catch(() => []);
  const cards = entries.filter((name) => /^card\d+$/.test(name));
  return Promise.all(cards.map(async (card) => {
    const base = `/sys/class/drm/${card}/device`;
    const [vendor, busy, vramUsed, vramTotal] = await Promise.all([
      readText(`${base}/vendor`),
      readText(`${base}/gpu_busy_percent`),
      readText(`${base}/mem_info_vram_used`),
      readText(`${base}/mem_info_vram_total`)
    ]);
    return { card, vendor, busy, vramUsed, vramTotal };
  }));
};
var createGpuCollector = (platform) => {
  if (platform === "darwin") {
    return {
      read: async () => {
        const result = await run(["/usr/sbin/ioreg", "ioreg"], ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
        if (!result.ok)
          return unavailable(result.missing ? "tool-missing" : "failed", "ioreg");
        return found(parseIoreg(result.stdout));
      },
      stop: () => {
        return;
      }
    };
  }
  if (platform === "linux") {
    return {
      read: async () => {
        const nvidia = await readNvidia(["nvidia-smi", "/usr/bin/nvidia-smi"]);
        if ("devices" in nvidia && nvidia.devices.length > 0)
          return { status: "ok", devices: nvidia.devices };
        const amd = parseAmdCards(await readAmdCards());
        if (amd.length > 0)
          return { status: "ok", devices: amd };
        if ("missing" in nvidia && !nvidia.missing)
          return unavailable("failed", "nvidia-smi");
        return unavailable("no-device");
      },
      stop: () => {
        return;
      }
    };
  }
  if (platform === "win32") {
    const loop = createGpuLoop();
    let useNvidia = true;
    return {
      read: async () => {
        if (useNvidia) {
          const nvidia = await readNvidia(NVIDIA_SMI_WIN32);
          if ("devices" in nvidia && nvidia.devices.length > 0)
            return { status: "ok", devices: nvidia.devices };
          if ("missing" in nvidia && nvidia.missing)
            useNvidia = false;
        }
        const sample = await loop.latest(WINDOWS_FIRST_SAMPLE_MS);
        if ("missing" in sample)
          return sample.missing ? unavailable("tool-missing", "powershell") : unavailable("failed");
        const devices = parseWindowsGpu(sample.line);
        return devices === null ? unavailable("failed") : found(devices);
      },
      stop: () => {
        useNvidia = true;
        loop.stop();
      }
    };
  }
  return { read: async () => unavailable("unsupported"), stop: () => {
    return;
  } };
};

// src/service/collectors/parse-network.ts
var byteCount = (value) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
var linkSpeed = (value) => {
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string")
    return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(bps|kbps|mbps|gbps|tbps)\s*$/i.exec(value);
  if (!match?.[1] || !match[2])
    return null;
  const multiplier = { bps: 1, kbps: 1000, mbps: 1e6, gbps: 1e9, tbps: 1000000000000 }[match[2].toLowerCase()];
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
var row = (name, receivedBytes, sentBytes, isDefault = null) => {
  const received = byteCount(receivedBytes);
  const sent = byteCount(sentBytes);
  if (!name || name === "lo" || name === "lo0" || name.toLowerCase().includes("loopback") || received === null || sent === null)
    return null;
  return {
    name: name.slice(0, 80),
    receivedBytes: received,
    sentBytes: sent,
    downloadBytesPerSecond: null,
    uploadBytesPerSecond: null,
    isDefault,
    linkSpeedBps: null
  };
};
var parseProcNetDev = (text, defaultInterface = null) => {
  const result = [];
  for (const line of text.split(/\r?\n/).slice(2)) {
    const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2])
      continue;
    const name = match[1].trim();
    const fields = match[2].trim().split(/\s+/);
    if (fields.length < 9)
      continue;
    const parsed = row(name, fields[0], fields[8], defaultInterface === null ? null : name === defaultInterface);
    if (parsed)
      result.push(parsed);
  }
  return result;
};
var parseDefaultRoute = (text) => {
  const route = text.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === "00000000" && fields[0] && (Number.parseInt(fields[3] ?? "", 16) & 1) === 1);
  return route?.[0] ?? null;
};
var parseDarwinNetstat = (text) => {
  const result = new Map;
  let receivedIndex = -1;
  let sentIndex = -1;
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "Name") {
      receivedIndex = fields.findIndex((field) => field.toLowerCase() === "ibytes");
      sentIndex = fields.findIndex((field) => field.toLowerCase() === "obytes");
      continue;
    }
    if (receivedIndex < 0 || sentIndex < 0 || fields.length <= Math.max(receivedIndex, sentIndex))
      continue;
    const parsed = row(fields[0] ?? "", fields[receivedIndex], fields[sentIndex]);
    if (parsed)
      result.set(parsed.name, parsed);
  }
  return [...result.values()];
};
var parseDarwinDefaultRoute = (text) => /^interface:\s*(\S+)\s*$/mi.exec(text)?.[1] ?? null;
var parseWindowsNetwork = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value];
  const result = [];
  for (const item of rows) {
    if (typeof item !== "object" || item === null)
      continue;
    const parsed = row(String(Reflect.get(item, "Name") ?? ""), Reflect.get(item, "ReceivedBytes"), Reflect.get(item, "SentBytes"), typeof Reflect.get(item, "Default") === "boolean" ? Reflect.get(item, "Default") : null);
    if (parsed)
      result.push({ ...parsed, linkSpeedBps: linkSpeed(Reflect.get(item, "LinkSpeed")) });
  }
  return result;
};
var deriveNetworkRates = (current, previous, elapsedMs) => current.map((item) => {
  const before = previous?.find((entry) => entry.name === item.name);
  if (!before || elapsedMs <= 0 || item.receivedBytes < before.receivedBytes || item.sentBytes < before.sentBytes)
    return item;
  return {
    ...item,
    downloadBytesPerSecond: (item.receivedBytes - before.receivedBytes) * 1000 / elapsedMs,
    uploadBytesPerSecond: (item.sentBytes - before.sentBytes) * 1000 / elapsedMs
  };
});

// src/service/collectors/network.ts
var WINDOWS_NETWORK = `
$ErrorActionPreference = 'SilentlyContinue'
$defaultRoute = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
$defaultIndex = if ($defaultRoute) { $defaultRoute.InterfaceIndex } else { $null }
@(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {
  $stats = $_ | Get-NetAdapterStatistics
  $isDefault = $null
  if ($null -ne $defaultIndex) { $isDefault = $_.ifIndex -eq $defaultIndex }
  [pscustomobject]@{ Name = $_.Name; ReceivedBytes = $stats.ReceivedBytes; SentBytes = $stats.SentBytes; Default = $isDefault; LinkSpeed = $_.LinkSpeed }
}) | ConvertTo-Json -Compress
`;
var activeLinuxInterfaces = async (interfaces) => Promise.all(interfaces.map(async (item) => {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(item.name))
    return null;
  const [state, speed] = await Promise.all([
    readText(`/sys/class/net/${item.name}/operstate`),
    readText(`/sys/class/net/${item.name}/speed`)
  ]);
  if (state?.trim() === "down")
    return null;
  const mbps = speed?.trim() ? Number(speed.trim()) : NaN;
  return { ...item, linkSpeedBps: Number.isFinite(mbps) && mbps > 0 ? mbps * 1e6 : null };
}));
var readNetwork = async (platform, now) => {
  let interfaces;
  if (platform === "linux") {
    const [dev, route] = await Promise.all([readText("/proc/net/dev"), readText("/proc/net/route")]);
    if (dev === null)
      return unavailable("failed");
    interfaces = (await activeLinuxInterfaces(parseProcNetDev(dev, route === null ? null : parseDefaultRoute(route)))).filter((item) => item !== null);
  } else if (platform === "darwin") {
    const [result, route] = await Promise.all([
      run(["/usr/sbin/netstat", "/usr/bin/netstat", "netstat"], ["-ibn"]),
      run(["/sbin/route", "/usr/sbin/route", "route"], ["-n", "get", "default"])
    ]);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "netstat");
    interfaces = parseDarwinNetstat(result.stdout);
    const defaultInterface = route.ok ? parseDarwinDefaultRoute(route.stdout) : null;
    if (defaultInterface)
      interfaces = interfaces.map((item) => ({ ...item, isDefault: item.name === defaultInterface }));
  } else if (platform === "win32") {
    const result = await runPowerShell(WINDOWS_NETWORK, 8000);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
    interfaces = parseWindowsNetwork(result.stdout);
    if (interfaces === null)
      return unavailable("failed");
  } else
    return unavailable("unsupported");
  return interfaces.length === 0 ? unavailable("no-device") : { status: "ok", interfaces, sampledAt: now };
};

// src/service/collectors/processes.ts
import os3 from "node:os";
import { readdir as readdir4 } from "node:fs/promises";

// src/service/collectors/parse-processes.ts
var safeNumber = (value) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
var safeName = (value) => {
  if (typeof value !== "string")
    return null;
  const name = value.trim().split(/[\\/]/).at(-1)?.slice(0, 100);
  return name && name !== "." ? name : null;
};
var parseLinuxProcessStat = (text) => {
  const match = /^(\d+) \((.*)\) ([^ ]+) (.*)$/.exec(text.trim());
  if (!match?.[1] || match[2] === undefined || !match[4])
    return null;
  const pid = Number(match[1]);
  const fields = match[4].split(/\s+/);
  const userTicks = safeNumber(fields[10]);
  const systemTicks = safeNumber(fields[11]);
  const parentPid = safeNumber(fields[0]);
  const threadCount = safeNumber(fields[16]);
  const name = safeName(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !name || userTicks === null || systemTicks === null)
    return null;
  return { pid, name, cpuTicks: userTicks + systemTicks, parentPid, threadCount, state: match[3] ?? null };
};
var parseLinuxProcessMemory = (text) => {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(text);
  const kib = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
};
var parseLinuxTotalCpuTicks = (text) => {
  const match = /^cpu\s+(.+)$/m.exec(text);
  if (!match?.[1])
    return null;
  const values = match[1].trim().split(/\s+/).map(Number);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value >= 0 ? value : 0), 0);
  return values.length >= 4 && Number.isSafeInteger(total) && total > 0 ? total : null;
};
var jsonRows = (text) => {
  try {
    const value = JSON.parse(text.trim() || "null");
    return Array.isArray(value) ? value : value === null ? [] : [value];
  } catch {
    return null;
  }
};
var parseWindowsProcesses = (text, limit = 20) => {
  const rows = jsonRows(text);
  if (rows === null)
    return null;
  const result = [];
  for (const value of rows) {
    if (typeof value !== "object" || value === null)
      continue;
    const pid = safeNumber(Reflect.get(value, "IDProcess") ?? Reflect.get(value, "IdProcess"));
    const name = safeName(Reflect.get(value, "Name"));
    const cpuPercent = safeNumber(Reflect.get(value, "PercentProcessorTime"));
    const memoryBytes = safeNumber(Reflect.get(value, "WorkingSetPrivate"));
    const parentPid = safeNumber(Reflect.get(value, "CreatingProcessID"));
    const threadCount = safeNumber(Reflect.get(value, "ThreadCount"));
    if (pid === null || pid <= 0 || !name)
      continue;
    result.push({ pid, name, cpuPercent, memoryBytes, ...parentPid !== null ? { parentPid } : {}, ...threadCount !== null ? { threadCount } : {} });
  }
  return result.slice(0, limit);
};
var parsePsProcesses = (text, limit = 20) => {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const extended = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const legacy = extended ? null : /^\s*(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
    const pidText = extended?.[1] ?? legacy?.[1];
    const rawName = extended?.[6] ?? legacy?.[2];
    const cpuText = extended?.[4] ?? legacy?.[3];
    const rssText = extended?.[5] ?? legacy?.[4];
    if (!pidText || !rawName || !cpuText || !rssText)
      continue;
    const pid = Number(pidText);
    const name = safeName(rawName);
    const cpuPercent = Number(cpuText);
    const rssKib = Number(rssText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || !Number.isFinite(cpuPercent) || !Number.isSafeInteger(rssKib))
      continue;
    result.push({
      pid,
      name,
      cpuPercent: Math.max(0, cpuPercent),
      memoryBytes: Math.max(0, rssKib) * 1024,
      ...extended ? { parentPid: Number(extended[2]), state: extended[3] } : {}
    });
  }
  return result.slice(0, limit);
};
var rankProcesses = (entries, limit) => ({
  topCpu: [...entries].filter((item) => item.cpuPercent !== null).sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)).slice(0, limit),
  topMemory: [...entries].filter((item) => item.memoryBytes !== null).sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)).slice(0, limit)
});
var processInventory = (entries, total, limit = 500) => {
  const ordered = [...entries].sort((a, b) => a.pid - b.pid);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const totalProcesses = Math.max(ordered.length, Math.floor(total));
  return { items: ordered.slice(0, safeLimit), totalProcesses, inventoryTruncated: totalProcesses > safeLimit };
};

// src/service/collectors/processes.ts
var WINDOWS_PROCESSES = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' } | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSetPrivate, CreatingProcessID, ThreadCount)
$cpu = @($rows | Sort-Object { [double]$_.PercentProcessorTime } -Descending | Select-Object -First 20)
$mem = @($rows | Sort-Object { [double]$_.WorkingSetPrivate } -Descending | Select-Object -First 20)
$items = @($rows | Sort-Object { [int]$_.IDProcess } | Select-Object -First 500)
@{ topCpu = $cpu; topMemory = $mem; items = $items; totalProcesses = $rows.Count } | ConvertTo-Json -Compress -Depth 3
`;
var createProcessCollector = (platform, now) => {
  let previousCpuTicks = null;
  let previousSystemTicks = null;
  const readLinux = async (limit) => {
    let pids;
    try {
      pids = (await readdir4("/proc")).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
    } catch {
      return unavailable("failed");
    }
    const systemTicks = parseLinuxTotalCpuTicks(await readText("/proc/stat") ?? "");
    if (systemTicks === null)
      return unavailable("failed");
    const totalProcesses = pids.length;
    const selectedPids = pids.slice(0, 2048);
    const current = [];
    for (let offset = 0;offset < selectedPids.length; offset += 64) {
      const chunk = await Promise.all(selectedPids.slice(offset, offset + 64).map(async (pidText) => {
        const [statText, statusText] = await Promise.all([
          readText(`/proc/${pidText}/stat`),
          readText(`/proc/${pidText}/status`)
        ]);
        const parsed = statText ? parseLinuxProcessStat(statText) : null;
        if (!parsed)
          return null;
        return {
          pid: parsed.pid,
          name: parsed.name,
          cpuTicks: parsed.cpuTicks,
          parentPid: parsed.parentPid,
          threadCount: parsed.threadCount,
          state: parsed.state,
          memoryBytes: statusText ? parseLinuxProcessMemory(statusText) : null
        };
      }));
      current.push(...chunk.filter((item) => item !== null));
    }
    const totalDelta = previousSystemTicks === null ? null : systemTicks - previousSystemTicks;
    const previous = previousCpuTicks;
    const entries = current.map((item) => {
      const before = previous?.get(item.pid);
      const delta = before === undefined ? null : item.cpuTicks - before;
      const cpuPercent = delta === null || totalDelta === null || totalDelta <= 0 || delta < 0 ? null : Math.min(100, delta / totalDelta * 100);
      return { pid: item.pid, name: item.name, cpuPercent, memoryBytes: item.memoryBytes, parentPid: item.parentPid, threadCount: item.threadCount, state: item.state };
    });
    previousCpuTicks = new Map(current.map((item) => [item.pid, item.cpuTicks]));
    previousSystemTicks = systemTicks;
    const ranked = rankProcesses(entries, limit);
    return { status: "ok", ...ranked, ...processInventory(entries, totalProcesses), sampledAt: now() };
  };
  const readOther = async (limit) => {
    let entries;
    if (platform === "win32") {
      const result = await runPowerShell(WINDOWS_PROCESSES, 8000);
      if (!result.ok)
        return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
      let data;
      try {
        data = JSON.parse(result.stdout.trim() || "{}");
      } catch {
        return unavailable("failed");
      }
      const fields = (key) => {
        const value = typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
        return JSON.stringify(value ?? []);
      };
      const cpu = parseWindowsProcesses(fields("topCpu"), 20)?.map((item) => ({
        ...item,
        cpuPercent: item.cpuPercent === null ? null : Math.min(100, item.cpuPercent / Math.max(1, os3.cpus().length))
      })) ?? null;
      const memory = parseWindowsProcesses(fields("topMemory"), 20);
      const items = parseWindowsProcesses(fields("items"), 500);
      const totalProcesses = typeof data === "object" && data !== null ? Number(Reflect.get(data, "totalProcesses")) : NaN;
      if (cpu === null || memory === null || items === null || !Number.isFinite(totalProcesses))
        return unavailable("failed");
      const union = new Map;
      for (const item of [...cpu, ...memory])
        union.set(item.pid, { ...union.get(item.pid), ...item });
      const ranked = rankProcesses([...union.values()], limit);
      return { status: "ok", ...ranked, ...processInventory(items.map((item) => ({ ...item, cpuPercent: item.cpuPercent === null ? null : Math.min(100, item.cpuPercent / Math.max(1, os3.cpus().length)) })), totalProcesses), sampledAt: now() };
    }
    if (platform === "darwin") {
      const result = await run(["/bin/ps", "ps"], ["-Ao", "pid=,ppid=,stat=,%cpu=,rss=,comm="]);
      if (!result.ok)
        return unavailable(result.missing ? "tool-missing" : "failed", "ps");
      entries = parsePsProcesses(result.stdout, 2048);
      if (entries === null)
        return unavailable("failed");
      const ranked = rankProcesses(entries, limit);
      const totalProcesses = result.stdout.split(/\r?\n/).filter((line) => /^\s*\d+\s/.test(line)).length;
      return { status: "ok", ...ranked, ...processInventory(entries, totalProcesses), sampledAt: now() };
    }
    return unavailable("unsupported");
  };
  return { read: (limit) => platform === "linux" ? readLinux(limit) : readOther(limit) };
};

// src/service/collectors/sensors.ts
import { readdir as readdir5 } from "node:fs/promises";

// src/service/collectors/parse-sensors.ts
var parseHwmonReading = (chip, label, raw) => {
  const milliCelsius = Number(raw.trim());
  const temperatureC = milliCelsius / 1000;
  if (!Number.isFinite(milliCelsius) || temperatureC < -40 || temperatureC > 150)
    return null;
  const name = `${chip.trim()} ${label.trim()}`.trim().slice(0, 80);
  if (!name)
    return null;
  const probe = `${chip} ${label}`.toLowerCase();
  const kind = /nvme|drivetemp|drive temperature/.test(probe) ? "disk" : /amdgpu|i915|nouveau|nvidia|gpu/.test(probe) ? "gpu" : /cpu|coretemp|k10temp|zenpower|package/.test(probe) ? "cpu" : "other";
  return { name, kind, temperatureC: Math.round(temperatureC * 10) / 10 };
};
var parseNvidiaTemperatures = (text) => text.split(/\r?\n/).flatMap((line, index) => {
  const [name, raw] = line.split(",").map((part) => part?.trim());
  const value = Number(raw);
  if (!name || !Number.isFinite(value) || value < -40 || value > 150)
    return [];
  return [{ name: `${name} GPU`, kind: "gpu", temperatureC: value }];
});

// src/service/collectors/sensors.ts
var readLinux = async () => {
  let controllers;
  try {
    controllers = await readdir5("/sys/class/hwmon");
  } catch {
    return unavailable("no-device");
  }
  const readings = [];
  for (const controller of controllers.slice(0, 64)) {
    const base = `/sys/class/hwmon/${controller}`;
    const [chip, files] = await Promise.all([readText(`${base}/name`), readdir5(base).catch(() => [])]);
    if (!chip)
      continue;
    const inputs = files.filter((name) => /^temp\d+_input$/.test(name)).slice(0, 32);
    for (const input of inputs) {
      const index = /^temp(\d+)_input$/.exec(input)?.[1];
      if (!index)
        continue;
      const [raw, label] = await Promise.all([
        readText(`${base}/${input}`),
        readText(`${base}/temp${index}_label`)
      ]);
      if (raw === null)
        continue;
      const parsed = parseHwmonReading(chip, label ?? `Sensor ${index}`, raw);
      if (parsed)
        readings.push(parsed);
    }
  }
  const nvidia = await run(["nvidia-smi"], ["--query-gpu=name,temperature.gpu", "--format=csv,noheader,nounits"]);
  if (nvidia.ok)
    readings.push(...parseNvidiaTemperatures(nvidia.stdout));
  return readings.length > 0 ? { status: "ok", readings, sampledAt: Date.now() } : unavailable("no-device");
};
var readNvidia2 = async () => {
  const result = await run(["nvidia-smi.exe", "nvidia-smi"], ["--query-gpu=name,temperature.gpu", "--format=csv,noheader,nounits"]);
  if (!result.ok)
    return unavailable(result.missing ? "no-device" : "failed", result.missing ? null : "nvidia-smi");
  const readings = parseNvidiaTemperatures(result.stdout);
  return readings.length > 0 ? { status: "ok", readings, sampledAt: Date.now() } : unavailable("no-device");
};
var readSensors = async (platform) => {
  if (platform === "linux")
    return readLinux();
  if (platform === "win32")
    return readNvidia2();
  return unavailable(platform === "darwin" ? "unsupported" : "unsupported");
};

// src/service/env.ts
import { existsSync } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
var currentPlatform = () => {
  const value = process.platform;
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
};
var CONTAINER_CGROUP = /(docker|kubepods|containerd|libpod|lxc)/;
var looksLikeContainer = (input) => input.dockerenv || input.containerenv || CONTAINER_CGROUP.test(input.initCgroup ?? "");
var detectContainer = async (platform) => {
  if (platform !== "linux")
    return false;
  const initCgroup = await readFile2("/proc/1/cgroup", "utf8").catch(() => null);
  return looksLikeContainer({
    dockerenv: existsSync("/.dockerenv"),
    containerenv: existsSync("/run/.containerenv"),
    initCgroup
  });
};

// src/service/sampler.ts
import os4 from "node:os";

// src/service/warnings.ts
var sustainedHigh = (history, threshold = WARN_PERCENT, seconds = 60) => {
  const required = Math.max(1, Math.ceil(seconds * 1000 / SAMPLE_INTERVAL_MS));
  if (history.length < required)
    return false;
  return history.slice(-required).every((value) => value !== null && value >= threshold);
};
var levelAt = (percent, warning, critical) => percent >= critical ? "critical" : percent >= warning ? "warn" : null;
var evaluateWarnings = (input, settings = DEFAULT_MONITOR_SETTINGS) => {
  const warnings = [];
  const thresholds = settings.thresholds;
  if (input.cpu.status === "ok" && input.cpuHistory.length > 0) {
    const critical = sustainedHigh(input.cpuHistory, thresholds.cpuCritical, thresholds.sustainedSeconds);
    const elevated = critical || sustainedHigh(input.cpuHistory, thresholds.cpuWarning, thresholds.sustainedSeconds);
    if (elevated)
      warnings.push({ kind: "cpu", target: null, level: critical ? "critical" : "warn" });
  }
  if (input.memory.status === "ok" && input.memory.total > 0) {
    const level = levelAt(input.memory.used / input.memory.total * 100, thresholds.memoryWarning, thresholds.memoryCritical);
    if (level)
      warnings.push({ kind: "memory", target: null, level });
    if (input.memory.swapTotal && input.memory.swapUsed !== null) {
      const swapPercent = input.memory.swapUsed / input.memory.swapTotal * 100;
      if (swapPercent >= thresholds.swapWarning)
        warnings.push({ kind: "swap", target: null, level: "warn" });
    }
  }
  if (input.gpuHistory.length > 0) {
    const critical = sustainedHigh(input.gpuHistory, thresholds.gpuCritical, thresholds.sustainedSeconds);
    const elevated = critical || sustainedHigh(input.gpuHistory, thresholds.gpuWarning, thresholds.sustainedSeconds);
    if (elevated)
      warnings.push({ kind: "gpu", target: null, level: critical ? "critical" : "warn" });
  }
  if (input.disks.status === "ok") {
    for (const disk of input.disks.items) {
      const percent = diskPercent(disk);
      if (percent === null)
        continue;
      const level = levelAt(percent, thresholds.diskWarning, thresholds.diskCritical);
      if (level)
        warnings.push({ kind: "disk", target: disk.mount, level });
    }
  }
  return warnings;
};

// src/shared/health.ts
var missing = (source) => source.status === "unavailable" && source.reason !== "no-device";
var evaluateHealth = (stats) => {
  const criticalCount = stats.warnings.filter((warning) => warning.level === "critical").length;
  const warningCount = stats.warnings.length;
  const unavailableCount = [stats.cpu, stats.memory, stats.disks].filter(missing).length;
  const coreUnavailable = unavailableCount === 3;
  return {
    state: coreUnavailable ? "unavailable" : criticalCount > 0 ? "critical" : warningCount > 0 ? "attention" : "healthy",
    warningCount,
    criticalCount,
    unavailableCount
  };
};

// src/service/sampler.ts
var PRIME_MS = 500;
var COMPUTER_INFO_INTERVAL_MS = 5 * 60000;
var NETWORK_INTERVAL_MS = 5000;
var PROCESS_INTERVAL_MS = 1e4;
var SENSOR_INTERVAL_MS = 1e4;
var BATTERY_INTERVAL_MS = 30000;
var DISK_ACTIVITY_INTERVAL_MS = 5000;
var freshSource = () => ({ value: unavailable("pending"), lastGood: null, failures: 0, retryAt: 0 });
var settle = (source, result, now) => {
  if (result.status === "ok") {
    source.value = result;
    source.lastGood = result;
    source.failures = 0;
    source.retryAt = 0;
    return;
  }
  if (result.reason === "failed") {
    source.failures += 1;
    if (source.failures < FAILURES_BEFORE_UNAVAILABLE) {
      source.value = source.lastGood ?? result;
      return;
    }
  }
  source.value = result;
  source.lastGood = null;
  source.retryAt = now + RETRY_UNAVAILABLE_MS;
};
var safely = async (read) => {
  try {
    return await read();
  } catch {
    return unavailable("failed");
  }
};
var due = (source, now) => source.retryAt <= now;

class RingBuffer {
  points;
  next = 0;
  count = 0;
  constructor(length) {
    this.points = Array.from({ length }, () => null);
  }
  push(value) {
    this.points[this.next] = value;
    this.next = (this.next + 1) % this.points.length;
    this.count = Math.min(this.points.length, this.count + 1);
  }
  clear() {
    this.next = 0;
    this.count = 0;
    this.points.fill(null);
  }
  values() {
    if (this.count < this.points.length)
      return this.points.slice(0, this.count);
    return [...this.points.slice(this.next), ...this.points.slice(0, this.next)];
  }
}
var pushHistory = (history, value) => history.push(value);
var createSampler = (deps) => {
  let generation = 0;
  let active = false;
  let paused = false;
  let lastRequest = 0;
  let cancelTimer = null;
  let first = null;
  let snapshot = null;
  let cpu = freshSource();
  let memory = freshSource();
  let gpu = freshSource();
  let disks = freshSource();
  let diskActivity = freshSource();
  let network = freshSource();
  let processes = freshSource();
  let battery = freshSource();
  let sensors = freshSource();
  let disksDueAt = 0;
  let networkDueAt = 0;
  let processesDueAt = 0;
  let batteryDueAt = 0;
  let sensorsDueAt = 0;
  let diskActivityDueAt = 0;
  let computerInfo = null;
  let computerInfoDueAt = 0;
  const cpuHistory = new RingBuffer(HISTORY_LENGTH);
  const gpuHistory = new RingBuffer(HISTORY_LENGTH);
  const memoryHistory = new RingBuffer(HISTORY_LENGTH);
  const networkDownHistory = new RingBuffer(HISTORY_LENGTH);
  const networkUpHistory = new RingBuffer(HISTORY_LENGTH);
  const cpuWarningHistory = new RingBuffer(WARNING_HISTORY_LENGTH);
  const gpuWarningHistory = new RingBuffer(WARNING_HISTORY_LENGTH);
  let historyIntervalMs = 0;
  let lastHistoryAt = 0;
  let previousNetwork = null;
  const reset = () => {
    cpu = freshSource();
    memory = freshSource();
    gpu = freshSource();
    disks = freshSource();
    diskActivity = freshSource();
    network = freshSource();
    processes = freshSource();
    battery = freshSource();
    sensors = freshSource();
    disksDueAt = 0;
    networkDueAt = 0;
    processesDueAt = 0;
    batteryDueAt = 0;
    sensorsDueAt = 0;
    diskActivityDueAt = 0;
    computerInfo = null;
    computerInfoDueAt = 0;
    cpuHistory.clear();
    gpuHistory.clear();
    memoryHistory.clear();
    networkDownHistory.clear();
    networkUpHistory.clear();
    cpuWarningHistory.clear();
    gpuWarningHistory.clear();
    historyIntervalMs = 0;
    lastHistoryAt = 0;
    previousNetwork = null;
    snapshot = null;
  };
  const stop = () => {
    generation += 1;
    active = false;
    first = null;
    cancelTimer?.();
    cancelTimer = null;
    deps.gpu.stop();
    reset();
  };
  const pause = () => {
    if (paused)
      return;
    paused = true;
    generation += 1;
    active = false;
    first = null;
    cancelTimer?.();
    cancelTimer = null;
    deps.gpu.stop();
  };
  const resume = () => {
    if (!paused)
      return;
    paused = false;
    if (snapshot)
      first = start();
  };
  const inFlight = new Map;
  const publish = (sampledAt, recordHistory) => {
    const settings = deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS;
    if (recordHistory) {
      const cpuPoint = cpu.value.status === "ok" ? cpu.value.total : null;
      const gpuPoint = busiestGpu(gpu.value);
      const memoryPoint = memory.value.status === "ok" && memory.value.total > 0 ? memory.value.used / memory.value.total * 100 : null;
      const rates = network.value.status === "ok" ? network.value.interfaces : [];
      const down = rates.map((item) => item.downloadBytesPerSecond).filter((value) => value !== null);
      const up = rates.map((item) => item.uploadBytesPerSecond).filter((value) => value !== null);
      cpuWarningHistory.push(cpuPoint);
      gpuWarningHistory.push(gpuPoint);
      const nextHistoryInterval = Math.floor(settings.historyMinutes * 60000 / HISTORY_LENGTH);
      if (nextHistoryInterval !== historyIntervalMs) {
        historyIntervalMs = nextHistoryInterval;
        lastHistoryAt = 0;
        cpuHistory.clear();
        gpuHistory.clear();
        memoryHistory.clear();
        networkDownHistory.clear();
        networkUpHistory.clear();
      }
      if (lastHistoryAt === 0 || sampledAt - lastHistoryAt >= historyIntervalMs) {
        pushHistory(cpuHistory, cpuPoint);
        pushHistory(gpuHistory, gpuPoint);
        pushHistory(memoryHistory, memoryPoint);
        pushHistory(networkDownHistory, down.length > 0 ? down.reduce((sum, value) => sum + value, 0) : null);
        pushHistory(networkUpHistory, up.length > 0 ? up.reduce((sum, value) => sum + value, 0) : null);
        lastHistoryAt = sampledAt;
      }
    }
    const warnings = evaluateWarnings({
      cpu: cpu.value,
      memory: memory.value,
      disks: disks.value,
      cpuHistory: cpuWarningHistory.values(),
      gpuHistory: gpuWarningHistory.values()
    }, settings);
    const nextSnapshot = {
      sampledAt,
      environment: {
        platform: deps.platform,
        container: deps.container,
        computer: {
          hostName: os4.hostname() || null,
          operatingSystem: [deps.platform === "win32" ? "Windows" : deps.platform === "darwin" ? "macOS" : os4.type(), os4.release()].filter(Boolean).join(" ") || null,
          architecture: os4.arch() || null,
          uptimeSeconds: Math.floor(os4.uptime()),
          details: computerInfo
        }
      },
      cpu: cpu.value,
      memory: memory.value,
      gpus: gpu.value,
      disks: disks.value,
      diskActivity: diskActivity.value,
      network: network.value,
      processes: processes.value,
      battery: battery.value,
      sensors: sensors.value,
      history: {
        cpu: cpuHistory.values(),
        gpu: gpuHistory.values(),
        memory: memoryHistory.values(),
        networkDown: networkDownHistory.values(),
        networkUp: networkUpHistory.values(),
        sampleIntervalMs: historyIntervalMs || SAMPLE_INTERVAL_MS
      },
      warnings,
      health: { state: "healthy", warningCount: 0, criticalCount: 0, unavailableCount: 0 }
    };
    snapshot = { ...nextSnapshot, health: evaluateHealth(nextSnapshot) };
  };
  const launchSource = (current, key, source, read, enabled) => {
    if (inFlight.get(key) === current)
      return;
    inFlight.set(key, current);
    safely(read).then((result) => {
      if (current !== generation)
        return;
      const settledAt = deps.now();
      if (enabled?.() === false) {
        source.value = unavailable("disabled");
        source.lastGood = null;
        source.failures = 0;
        source.retryAt = 0;
      } else {
        settle(source, result, settledAt);
      }
      publish(settledAt, false);
    }).finally(() => {
      if (inFlight.get(key) === current)
        inFlight.delete(key);
    });
  };
  const tick = async (current) => {
    const now = deps.now();
    if (snapshot === null && networkDueAt === 0) {
      networkDueAt = now + 2500;
      diskActivityDueAt = now + 3000;
      processesDueAt = now + 5000;
      sensorsDueAt = now + 5000;
      batteryDueAt = now + 1e4;
    }
    const settings = deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS;
    const cpuResult = due(cpu, now) ? await safely(deps.cpuMem.cpu) : null;
    if (current !== generation)
      return;
    const settledAt = deps.now();
    if (cpuResult)
      settle(cpu, cpuResult, settledAt);
    if (due(memory, now))
      launchSource(current, "memory", memory, deps.cpuMem.memory);
    if (due(gpu, now))
      launchSource(current, "gpu", gpu, deps.gpu.read);
    if (due(disks, now) && now >= disksDueAt) {
      disksDueAt = now + DISK_INTERVAL_MS;
      launchSource(current, "disks", disks, async () => {
        const result = await deps.disks();
        return Array.isArray(result) ? { status: "ok", items: result, sampledAt: deps.now() } : result;
      });
    }
    if (deps.computerInfo && now >= computerInfoDueAt && inFlight.get("computerInfo") !== current) {
      computerInfoDueAt = now + COMPUTER_INFO_INTERVAL_MS;
      inFlight.set("computerInfo", current);
      safely(deps.computerInfo).then((result) => {
        if (current !== generation)
          return;
        computerInfo = "status" in result ? null : result;
        publish(deps.now(), false);
      }).finally(() => {
        if (inFlight.get("computerInfo") === current)
          inFlight.delete("computerInfo");
      });
    }
    if (deps.network && !settings.modules.network) {
      network.value = unavailable("disabled");
      network.lastGood = null;
      network.failures = 0;
      network.retryAt = 0;
      previousNetwork = null;
    } else if (deps.network && due(network, now) && now >= networkDueAt) {
      networkDueAt = now + NETWORK_INTERVAL_MS;
      launchSource(current, "network", network, async () => {
        const result = await deps.network();
        if (result.status !== "ok")
          return result;
        const at = deps.now();
        const elapsed = previousNetwork ? at - previousNetwork.sampledAt : 0;
        const sampled = { ...result, interfaces: deriveNetworkRates(result.interfaces, previousNetwork?.interfaces ?? null, elapsed), sampledAt: at };
        previousNetwork = sampled;
        return sampled;
      }, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.network);
    }
    if (deps.processes && !settings.modules.processes) {
      processes.value = unavailable("disabled");
      processes.lastGood = null;
      processes.failures = 0;
      processes.retryAt = 0;
    } else if (deps.processes && due(processes, now) && now >= processesDueAt) {
      processesDueAt = now + PROCESS_INTERVAL_MS;
      launchSource(current, "processes", processes, () => deps.processes(settings.processLimit), () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.processes);
    }
    if (deps.battery && !settings.modules.battery) {
      battery.value = unavailable("disabled");
      battery.lastGood = null;
      battery.failures = 0;
      battery.retryAt = 0;
    } else if (deps.battery && due(battery, now) && now >= batteryDueAt) {
      batteryDueAt = now + BATTERY_INTERVAL_MS;
      launchSource(current, "battery", battery, deps.battery, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.battery);
    }
    if (deps.sensors && !settings.modules.sensors) {
      sensors.value = unavailable("disabled");
      sensors.lastGood = null;
      sensors.failures = 0;
      sensors.retryAt = 0;
    } else if (deps.sensors && due(sensors, now) && now >= sensorsDueAt) {
      sensorsDueAt = now + SENSOR_INTERVAL_MS;
      launchSource(current, "sensors", sensors, deps.sensors, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.sensors);
    }
    if (deps.diskActivity && due(diskActivity, now) && now >= diskActivityDueAt) {
      diskActivityDueAt = now + DISK_ACTIVITY_INTERVAL_MS;
      launchSource(current, "diskActivity", diskActivity, deps.diskActivity);
    }
    publish(settledAt, true);
  };
  const loop = (current) => {
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      if (current !== generation)
        return;
      if (deps.now() - lastRequest >= IDLE_STOP_MS) {
        stop();
        return;
      }
      tick(current).finally(() => {
        if (current === generation)
          loop(current);
      });
    }, SAMPLE_INTERVAL_MS);
  };
  const start = () => {
    if (paused)
      return Promise.resolve();
    active = true;
    const current = generation;
    return (async () => {
      await deps.cpuMem.prime().catch(() => {
        return;
      });
      await deps.wait(PRIME_MS);
      if (current !== generation)
        return;
      await tick(current);
      if (current === generation)
        loop(current);
    })();
  };
  return {
    stats: async () => {
      lastRequest = deps.now();
      if (paused && snapshot)
        return snapshot;
      if (!active)
        first = start();
      if (first)
        await first;
      if (!snapshot)
        throw new Error("Sampling stopped before the first reading.");
      return snapshot;
    },
    stop,
    pause,
    resume,
    running: () => active
  };
};

// src/shared/wsl.ts
var inspectWslConfig = (text) => {
  let section = "";
  const settings = new Map;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading) {
      section = heading[1].trim().toLocaleLowerCase();
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/.exec(trimmed);
    if (!assignment)
      continue;
    const key = assignment[1].toLocaleLowerCase();
    const value = assignment[2].replace(/^(["'])(.*)\1$/, "$2").trim();
    settings.set(`${section}.${key}`, value);
  }
  const visible = new Set([
    "wsl2.memory",
    "wsl2.processors",
    "wsl2.swap",
    "wsl2.defaultvhdsize",
    "wsl2.networkingmode",
    "wsl2.localhostforwarding",
    "wsl2.dnsproxy",
    "wsl2.hostaddressloopback",
    "wsl2.ignoredports",
    "wsl2.safemode",
    "wsl2.maxcrashdumpcount",
    "wsl2.dnstunneling",
    "wsl2.autoproxy",
    "wsl2.guiapplications",
    "wsl2.gpusupport",
    "wsl2.nestedvirtualization",
    "wsl2.debugconsole",
    "wsl2.vmidletimeout",
    "experimental.sparsevhd",
    "experimental.besteffortdnsparsing",
    "experimental.automemoryreclaim",
    "general.instanceidletimeout",
    "boot.systemd",
    "boot.command",
    "boot.protectbinfmt",
    "boot.inittimeout",
    "automount.enabled",
    "automount.mountfstab",
    "automount.root",
    "automount.options",
    "automount.cgroups",
    "automount.ldconfig",
    "interop.enabled",
    "interop.appendwindowspath",
    "network.generatehosts",
    "network.generateresolvconf",
    "network.hostname",
    "gpu.enabled",
    "gpu.appendlibpath",
    "time.usewindowstimezone",
    "user.default"
  ]);
  const insights = [...settings].filter(([path]) => visible.has(path)).map(([path, value]) => {
    const [sectionName, key] = path.split(".");
    return { section: sectionName, key, value };
  });
  return {
    insights,
    hasBootCommand: Boolean(settings.get("boot.command")?.trim()),
    networkingDisabled: settings.get("wsl2.networkingmode")?.toLocaleLowerCase() === "none"
  };
};
var safeDistroName = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith("-");
var safeWindowsPath = (value) => {
  if (typeof value !== "string" || value.length <= 3 || value.length > 240 || !/^[A-Za-z]:\\/.test(value) || /[\u0000-\u001f\u007f"<>|?*]/.test(value))
    return false;
  const segments = value.slice(3).split(/[\\/]/);
  return segments.length > 0 && segments.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes(":") && !part.endsWith(".") && !part.endsWith(" ") && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part));
};
var record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var parseWslAction = (value) => {
  if (!record(value) || typeof value.action !== "string")
    return null;
  const distro = value.distro;
  const isDistro = safeDistroName(distro);
  const confirmation = typeof value.confirmation === "string" ? value.confirmation : "";
  switch (value.action) {
    case "start":
    case "stop":
    case "restart":
    case "set-default":
    case "open-terminal":
    case "open-files":
    case "open-vscode":
    case "open-rdp":
      return isDistro ? { action: value.action, distro } : null;
    case "set-version":
      return isDistro && (value.version === 1 || value.version === 2) && confirmation === `SET VERSION ${distro} ${value.version}` ? { action: "set-version", distro, version: value.version, confirmation } : null;
    case "set-default-version":
      return (value.version === 1 || value.version === 2) && confirmation === `DEFAULT WSL ${value.version}` ? { action: "set-default-version", version: value.version, confirmation } : null;
    case "update-wsl":
      return confirmation === "UPDATE WSL" ? { action: "update-wsl", confirmation } : null;
    case "set-default-user":
      return isDistro && typeof value.username === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(value.username) && confirmation === `USER ${value.username}` ? { action: "set-default-user", distro, username: value.username, confirmation } : null;
    case "install":
      return isDistro ? { action: "install", distro } : null;
    case "export":
      return isDistro && safeWindowsPath(value.file) && (value.format === "tar" || value.format === "vhd") ? { action: "export", distro, file: value.file, format: value.format } : null;
    case "import":
      return isDistro && safeWindowsPath(value.location) && safeWindowsPath(value.file) && (value.version === 1 || value.version === 2) && (value.format === "tar" || value.format === "vhd") && (value.format !== "vhd" || value.version === 2) ? { action: "import", distro, location: value.location, file: value.file, version: value.version, format: value.format } : null;
    case "import-in-place":
      return isDistro && safeWindowsPath(value.file) && /\.vhdx$/i.test(value.file) ? { action: "import-in-place", distro, file: value.file } : null;
    case "install-from-file": {
      const expected = `INSTALL ${distro} FROM FILE`;
      return isDistro && safeWindowsPath(value.file) && /\.wsl$/i.test(value.file) && safeWindowsPath(value.location) && (value.version === 1 || value.version === 2) && confirmation === expected ? { action: "install-from-file", distro, file: value.file, location: value.location, version: value.version, confirmation } : null;
    }
    case "clone":
    case "rename": {
      const newDistro = value.newDistro;
      const expected = typeof newDistro === "string" ? `${value.action.toLocaleUpperCase()} ${distro} AS ${newDistro}` : "";
      return isDistro && safeDistroName(newDistro) && safeWindowsPath(value.location) && newDistro.toLocaleLowerCase() !== distro.toLocaleLowerCase() && (value.version === 1 || value.version === 2) && confirmation === expected ? { action: value.action, distro, newDistro, location: value.location, version: value.version, confirmation } : null;
    }
    case "move":
      return isDistro && safeWindowsPath(value.location) && confirmation === distro ? { action: "move", distro, location: value.location, confirmation } : null;
    case "resize":
      return isDistro && typeof value.size === "string" && /^\d+(?:B|KB|MB|GB|TB)?$/i.test(value.size) && confirmation === `RESIZE ${distro}` ? { action: "resize", distro, size: value.size, confirmation } : null;
    case "compact":
      return isDistro && confirmation === `COMPACT ${distro}` ? { action: "compact", distro, confirmation } : null;
    case "set-sparse":
      return isDistro && typeof value.enabled === "boolean" ? { action: "set-sparse", distro, enabled: value.enabled } : null;
    case "shutdown":
      return confirmation === "SHUTDOWN WSL" ? { action: "shutdown", confirmation } : null;
    case "force-shutdown":
      return confirmation === "FORCE SHUTDOWN WSL" ? { action: "force-shutdown", confirmation } : null;
    case "unregister":
      return isDistro && confirmation === distro ? { action: "unregister", distro, confirmation } : null;
    default:
      return null;
  }
};
var parseWslConfigUpdate = (value) => {
  if (!record(value) || typeof value.text !== "string" || value.text.length > 16384 || value.text.includes("\x00"))
    return null;
  const text = value.text.replace(/\r\n?/g, `
`);
  if (value.kind === "global") {
    return value.confirmation === "SAVE GLOBAL WSL CONFIG" ? { kind: "global", text, confirmation: value.confirmation } : null;
  }
  if (value.kind === "distribution" && safeDistroName(value.distro)) {
    const confirmation = `SAVE WSL CONFIG ${value.distro}`;
    return value.confirmation === confirmation ? { kind: "distribution", distro: value.distro, text, confirmation } : null;
  }
  return null;
};

// src/service/wsl.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile as readFile3, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/service/collectors/parse-wsl.ts
import { isIP } from "node:net";
var parseWslDiagnostics = (input) => {
  const text = decodeWslText(input);
  const section = (name) => {
    const marker = `__${name}__
`;
    const start = text.indexOf(marker);
    if (start < 0)
      return null;
    const content = text.slice(start + marker.length);
    const end = content.search(/\n__/);
    return (end < 0 ? content : content.slice(0, end)).trim();
  };
  const legacyProcesses = section("PROCESSES");
  const cpuProcesses = section("PROCESSES_CPU");
  const memoryProcesses = section("PROCESSES_MEMORY");
  const processSources = cpuProcesses !== null || memoryProcesses !== null ? [cpuProcesses, memoryProcesses] : [legacyProcesses];
  const processUnavailable = processSources.some((source) => source === "__UNAVAILABLE__");
  const processes = processSources.every((source) => source === null) || processUnavailable ? {
    status: "unavailable",
    reason: processUnavailable ? "The ps utility is not available in this distribution." : "Process data was not returned.",
    items: []
  } : (() => {
    const items = new Map;
    for (let sourceIndex = 0;sourceIndex < processSources.length; sourceIndex += 1) {
      const source = processSources[sourceIndex];
      if (source == null)
        continue;
      for (const line of source.split(`
`)) {
        const value = line.trim();
        const modern = sourceIndex < 2 && (cpuProcesses !== null || memoryProcesses !== null);
        const match = modern ? /^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(value) : /^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(value);
        if (!match)
          continue;
        const pid = Number(match[1]);
        const cpuPercent = Number(modern ? match[2] : match[3]);
        const memoryPercent = Number(modern ? match[3] : match[4]);
        const name = (modern ? match[4] : match[2])?.trim();
        if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(cpuPercent) || cpuPercent < 0 || !Number.isFinite(memoryPercent) || memoryPercent < 0 || !name)
          continue;
        items.set(pid, { pid, name: name.slice(0, 64), cpuPercent, memoryPercent });
      }
    }
    return { status: "ok", items: [...items.values()].slice(0, cpuProcesses !== null || memoryProcesses !== null ? 200 : 10) };
  })();
  const portsText = section("PORTS");
  const listeningPorts = portsText === null || portsText === "__UNAVAILABLE__" ? { status: "unavailable", reason: portsText === null ? "Network data was not returned." : "The ss utility is not available in this distribution.", items: [] } : {
    status: "ok",
    items: portsText.split(`
`).flatMap((line) => {
      const match = line.trim().match(/^(tcp|udp)\s+(.+):(\d+)(?:\s+.*)?$/i);
      if (!match)
        return [];
      const port = Number(match[3]);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return [];
      const owner = /users:\(\("([^"\r\n]{1,80})",pid=(\d+),fd=\d+\)/.exec(line);
      const ownerPid = owner?.[2] ? Number(owner[2]) : NaN;
      const processName = owner?.[1]?.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) || null;
      return [{
        protocol: match[1].toLowerCase(),
        address: match[2].slice(0, 80),
        port,
        processName,
        pid: Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null
      }];
    }).filter((item, index, items) => items.findIndex((candidate) => candidate.protocol === item.protocol && candidate.address === item.address && candidate.port === item.port && candidate.pid === item.pid) === index).slice(0, 100)
  };
  const servicesText = section("SERVICES");
  const services = servicesText === null || servicesText === "__UNAVAILABLE__" ? { status: "unavailable", reason: servicesText === null ? "Service data was not returned." : "systemd is unavailable or not running in this distribution.", items: [] } : {
    status: "ok",
    items: servicesText.split(`
`).flatMap((line) => {
      const match = /^([A-Za-z0-9_.@:-]+\.service)\s+(loaded|not-found|masked|error)\s+(active|inactive|failed|activating|deactivating|reloading)\s+(running|exited|dead|failed|waiting|start|stop|auto-restart|condition)\s*(.*)$/.exec(line.trim());
      if (!match)
        return [];
      return [{ unit: match[1].slice(0, 128), loadState: match[2], activeState: match[3], subState: match[4], description: match[5].trim().slice(0, 240) || null }];
    }).filter((item, index, items) => items.findIndex((candidate) => candidate.unit === item.unit) === index).slice(0, 100)
  };
  const mountsText = section("MOUNTS");
  let mounts;
  if (mountsText === null || mountsText === "__UNAVAILABLE__") {
    mounts = { status: "unavailable", reason: mountsText === "__UNAVAILABLE__" ? "The findmnt utility is not available in this distribution." : "Mount data was not returned.", items: [] };
  } else {
    try {
      const parsed = JSON.parse(mountsText);
      const filesystems = typeof parsed === "object" && parsed !== null && "filesystems" in parsed ? parsed.filesystems : null;
      const sanitize = (value) => typeof value === "string" && value.trim().length > 0 ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) || null : null;
      const items = Array.isArray(filesystems) ? filesystems.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null)
          return [];
        const item = entry;
        const source = sanitize(item.source);
        const target = sanitize(item.target);
        const fileSystem = sanitize(item.fstype);
        return source && target && fileSystem ? [{ source, target, fileSystem }] : [];
      }).slice(0, 100) : [];
      mounts = { status: "ok", items };
    } catch {
      mounts = { status: "unavailable", reason: "Mount data could not be parsed.", items: [] };
    }
  }
  const networkText = section("NETWORK");
  let addresses = [];
  let gateway = null;
  let dnsServers = [];
  let configuredMode = null;
  let networkUnavailable = networkText === null || networkText === "__UNAVAILABLE__";
  if (!networkUnavailable && networkText !== null) {
    for (const line of networkText.split(`
`)) {
      const separator = line.indexOf("=");
      if (separator < 0)
        continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "ADDRESSES")
        addresses = value.split(/\s+/).filter((item) => isIP(item) !== 0).slice(0, 16);
      if (key === "GATEWAY" && isIP(value) !== 0)
        gateway = value;
      if (key === "DNS")
        dnsServers = value.split(/\s+/).filter((item) => isIP(item) !== 0).slice(0, 8);
      if (key === "MODE" && /^[a-z][a-z0-9_-]{0,31}$/i.test(value))
        configuredMode = value;
    }
    networkUnavailable = !networkText.split(`
`).some((line) => line.startsWith("ADDRESSES="));
  }
  const network = networkUnavailable ? { status: "unavailable", reason: networkText === "__UNAVAILABLE__" ? "The guest network tools are not available in this distribution." : "Network data was not returned by the guest probe.", addresses: [], gateway: null, dnsServers: [], configuredMode } : { status: "ok", addresses, gateway, dnsServers, configuredMode };
  return { processes, listeningPorts, services, mounts, network };
};
var decodeWslText = (input) => {
  if (typeof input === "string")
    return input.replace(/^\uFEFF/, "").replaceAll("\x00", "").replace(/\r/g, "");
  const bytes = Buffer.from(input);
  const sample = bytes.subarray(0, Math.min(bytes.length, 64));
  let zeroes = 0;
  for (let index = 1;index < sample.length; index += 2)
    if (sample[index] === 0)
      zeroes += 1;
  const utf16le = sample.length > 2 && zeroes / Math.max(1, Math.floor(sample.length / 2)) > 0.35;
  const text = utf16le ? bytes.toString("utf16le") : bytes.toString("utf8");
  return text.replace(/^\uFEFF/, "").replaceAll("\x00", "").replace(/\r/g, "");
};
var finiteBytes = (value) => {
  if (!value)
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
var parseWslList = (input) => {
  const rows = [];
  for (const rawLine of decodeWslText(input).split(`
`)) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\s*(\*)?\s*(.+?)\s{2,}(.+?)\s{2,}([12])\s*$/);
    if (!match || !match[2] || !match[3])
      continue;
    const name = match[2].trim();
    const localizedState = match[3].trim().toLocaleLowerCase();
    if (!name || /^(name|nom)$/i.test(name))
      continue;
    const state = /running|run|cours|ex[eé]cut/.test(localizedState) ? "running" : /stopped|stop|arr[eê]t|termin/.test(localizedState) ? "stopped" : "unknown";
    rows.push({
      name,
      source: "unknown",
      state,
      version: Number(match[4]) === 1 || Number(match[4]) === 2 ? Number(match[4]) : null,
      isDefault: match[1] === "*",
      virtualDiskBytes: null,
      osName: null,
      osVersion: null,
      kernel: null,
      rootUsedBytes: null,
      rootTotalBytes: null,
      processCount: null,
      gpu: null,
      remoteDesktopPort: null
    });
  }
  return rows;
};
var parseWslVersions = (input) => {
  const values = new Map;
  for (const line of decodeWslText(input).split(`
`)) {
    const split = line.indexOf(":");
    if (split < 0)
      continue;
    values.set(line.slice(0, split).trim().toLocaleLowerCase(), line.slice(split + 1).trim());
  }
  const pick = (...keys) => keys.map((key) => values.get(key)).find((value) => value && value.length > 0) ?? null;
  return {
    version: pick("wsl version", "version du wsl", "version wsl"),
    kernelVersion: pick("kernel version", "version du noyau", "version du kernel"),
    wslgVersion: pick("wslg version", "version wslg")
  };
};
var parseWslDefaultVersion = (input) => {
  for (const line of decodeWslText(input).split(`
`)) {
    const normalized = line.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
    const match = normalized.match(/^\s*(?:default\s+version|version\s+par\s+defaut|version\s+predeterminada)\s*:\s*([12])\s*$/);
    if (match?.[1] === "1" || match?.[1] === "2")
      return Number(match[1]);
  }
  return null;
};
var parseWslDistroDetails = (input) => {
  const text = decodeWslText(input);
  const marker = (name) => {
    const token = `__${name}__
`;
    const start = text.indexOf(token);
    if (start < 0)
      return "";
    const content = text.slice(start + token.length);
    const end = content.search(/\n__/);
    return end < 0 ? content : content.slice(0, end);
  };
  const os = new Map;
  for (const line of marker("OS").split(`
`)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match?.[1])
      os.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""));
  }
  const memory = marker("MEM").match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)/m);
  const disk = marker("DISK").match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)/m);
  const kernel = text.match(/\n__KERNEL__=(.*)/)?.[1]?.trim() || null;
  const processCount = text.match(/\n__PROCS__=(\d+)/)?.[1];
  const gpuParts = text.match(/(?:^|\n)__GPU__=([01]),([01]),([01]),([01])(?:\n|$)/);
  const gpu = gpuParts ? {
    directX: gpuParts[1] === "1",
    cudaLibrary: gpuParts[2] === "1",
    nvidiaToolkit: gpuParts[3] === "1",
    cdiSpec: gpuParts[4] === "1"
  } : null;
  const remoteDesktopPortValue = Number(text.match(/(?:^|\n)__XRDP__=(\d{1,5})(?:\n|$)/)?.[1]);
  const remoteDesktopPort = Number.isInteger(remoteDesktopPortValue) && remoteDesktopPortValue >= 1 && remoteDesktopPortValue <= 65535 ? remoteDesktopPortValue : null;
  return {
    osName: os.get("PRETTY_NAME") ?? os.get("NAME") ?? null,
    osVersion: os.get("VERSION_ID") ?? null,
    kernel,
    memoryUsedBytes: finiteBytes(memory?.[2]),
    memoryTotalBytes: finiteBytes(memory?.[1]),
    rootUsedBytes: finiteBytes(disk?.[2]),
    rootTotalBytes: disk?.[1] ? finiteBytes(disk[1]) : null,
    processCount: finiteBytes(processCount),
    gpu,
    remoteDesktopPort
  };
};
var parseWslRegistrationMetadata = (input) => {
  try {
    const decoded = decodeWslText(input).trim();
    if (!decoded)
      return [];
    const value = JSON.parse(decoded);
    const entries = Array.isArray(value) ? value : [value];
    const result = [];
    for (const item of entries) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        continue;
      const row = item;
      if (typeof row.Name !== "string" || !row.Name.trim() || row.Name.length > 128)
        continue;
      const bytes = typeof row.VirtualDiskBytes === "number" && Number.isSafeInteger(row.VirtualDiskBytes) && row.VirtualDiskBytes >= 0 ? row.VirtualDiskBytes : null;
      result.push({
        name: row.Name,
        source: row.Source === "store" || row.Source === "imported" ? row.Source : "unknown",
        virtualDiskBytes: bytes
      });
    }
    return result;
  } catch {
    return [];
  }
};
var parseWslCatalog = (input) => {
  const items = [];
  const seen = new Set;
  for (const line of decodeWslText(input).split(`
`)) {
    const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s{2,}(.+?)\s*$/);
    if (!match?.[1] || !match[2] || /^(name|nom|install|the)$/i.test(match[1]))
      continue;
    const name = match[1];
    const key = name.toLocaleLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    items.push({ name, friendlyName: match[2].trim() });
  }
  return items;
};

// src/service/collectors/parse-wsl-conf.ts
var withDefaultWslUser = (input, username) => {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username))
    throw new Error("Invalid Linux username.");
  const lines = input.replace(/\r\n?/g, `
`).split(`
`);
  const output = [];
  let inUserSection = false;
  let foundUserSection = false;
  let wroteDefault = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (section) {
      if (inUserSection && !wroteDefault) {
        output.push(`default=${username}`);
        wroteDefault = true;
      }
      inUserSection = section[1]?.trim().toLocaleLowerCase() === "user";
      if (inUserSection)
        foundUserSection = true;
      wroteDefault = false;
      output.push(line);
      continue;
    }
    if (inUserSection) {
      const value = line.match(/^(\s*default\s*=\s*).*$/i);
      if (value) {
        output.push(`${value[1]}${username}`);
        wroteDefault = true;
        continue;
      }
    }
    output.push(line);
  }
  if (inUserSection && !wroteDefault)
    output.push(`default=${username}`);
  if (!foundUserSection) {
    while (output.at(-1) === "")
      output.pop();
    if (output.length > 0)
      output.push("");
    output.push("[user]", `default=${username}`);
  }
  return `${output.join(`
`).replace(/\n+$/, "")}
`;
};

// src/service/wsl.ts
var root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
var wslExe = join(root, "System32", "wsl.exe");
var knownName = (value) => value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith("-");
var cleanError = (value) => decodeWslText(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || "WSL a retourné une erreur sans détail.";
var runWsl = (args, timeoutMs = 15000) => new Promise((resolve) => {
  execFile2(wslExe, args, { encoding: "buffer", timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    const output = decodeWslText(stdout ?? "");
    if (!error) {
      resolve({ ok: true, stdout: output });
      return;
    }
    const missing = "code" in error && error.code === "ENOENT";
    resolve({ ok: false, missing, error: cleanError(decodeWslText(stderr ?? "") || output || error.message) });
  });
});
var unavailable2 = (reason, error) => ({
  supported: false,
  reason,
  version: null,
  defaultVersion: null,
  kernelVersion: null,
  wslgVersion: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  distributions: [],
  sampledAt: Date.now(),
  error
});
var distroMetadataScript = `$ErrorActionPreference = 'SilentlyContinue'
$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
$rows = @()
if (Test-Path -LiteralPath $root) {
  $rows = @(Get-ChildItem -LiteralPath $root | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath
    $disk = $null
    $vhd = if ($entry.BasePath) { Join-Path $entry.BasePath 'ext4.vhdx' } else { $null }
    if ($vhd -and (Test-Path -LiteralPath $vhd)) { $disk = (Get-Item -LiteralPath $vhd).Length }
    [pscustomobject]@{
      Name = [string]$entry.DistributionName
      Source = if ($entry.PackageFamilyName) { 'store' } elseif ($entry.BasePath) { 'imported' } else { 'unknown' }
      VirtualDiskBytes = $disk
    }
  })
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress))`;
var metadataCache = null;
var readRegistrationMetadata = async () => {
  if (metadataCache && metadataCache.expiresAt > Date.now())
    return metadataCache.items;
  const result = await runPowerShell(distroMetadataScript, 12000);
  const items = new Map;
  if (result.ok) {
    for (const row of parseWslRegistrationMetadata(result.stdout)) {
      items.set(row.name.toLocaleLowerCase(), { source: row.source, virtualDiskBytes: row.virtualDiskBytes });
    }
  }
  metadataCache = { expiresAt: Date.now() + 5 * 60000, items };
  return items;
};
var detailsCache = new Map;
var enrichDistro = async (distro) => {
  if (distro.state !== "running")
    return { distribution: distro, memoryUsedBytes: null, memoryTotalBytes: null };
  const cacheKey = distro.name.toLocaleLowerCase();
  const cached = detailsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const { memoryUsedBytes, memoryTotalBytes, ...details } = cached.details;
    return { distribution: { ...distro, ...details }, memoryUsedBytes, memoryTotalBytes };
  }
  const probe = [
    'printf "__OS__\\n"; cat /etc/os-release 2>/dev/null || true',
    'printf "\\n__KERNEL__=%s\\n" "$(uname -r 2>/dev/null)"',
    'printf "__MEM__\\n"; free -b 2>/dev/null | grep "^Mem:" || true',
    'printf "__DISK__\\n"; df -B1 / 2>/dev/null | tail -n 1',
    'printf "__PROCS__=%s\\n" "$(ps -e --no-headers 2>/dev/null | wc -l)"',
    'printf "__GPU__=%s,%s,%s,%s\\n" "$(test -e /dev/dxg && echo 1 || echo 0)" "$(test -e /usr/lib/wsl/lib/libcuda.so.1 && echo 1 || echo 0)" "$(command -v nvidia-ctk >/dev/null 2>&1 && echo 1 || echo 0)" "$(test -f /etc/cdi/nvidia.yaml && echo 1 || echo 0)"',
    `printf "__XRDP__=%s\\n" "$(awk -F= '/^[[:space:]]*port[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); if ($2 ~ /^[0-9]+$/) {print $2; exit}}' /etc/xrdp/xrdp.ini 2>/dev/null)"`
  ].join("; ");
  const result = await runWsl(["--distribution", distro.name, "--exec", "sh", "-c", probe], 1e4);
  if (!result.ok)
    return { distribution: distro, memoryUsedBytes: null, memoryTotalBytes: null };
  const details = parseWslDistroDetails(result.stdout);
  detailsCache.set(cacheKey, { expiresAt: Date.now() + 20000, details });
  const { memoryUsedBytes, memoryTotalBytes, ...distributionDetails } = details;
  return { distribution: { ...distro, ...distributionDetails }, memoryUsedBytes, memoryTotalBytes };
};
var readWslSnapshot = async () => {
  if (process.platform !== "win32")
    return unavailable2("unsupported", "La gestion WSL est disponible lorsque le service OpenChamber tourne sur Windows.");
  const [versionResult, listResult, statusResult, metadata] = await Promise.all([
    runWsl(["--version"]),
    runWsl(["--list", "--verbose"]),
    runWsl(["--status"]),
    readRegistrationMetadata()
  ]);
  if (listResult.ok === false) {
    return unavailable2(listResult.missing ? "tool-missing" : "failed", listResult.error);
  }
  const version = versionResult.ok ? parseWslVersions(versionResult.stdout) : { version: null, kernelVersion: null, wslgVersion: null };
  const distributions = parseWslList(listResult.stdout).map((distro) => ({
    ...distro,
    ...metadata.get(distro.name.toLocaleLowerCase()) ?? {}
  }));
  const enriched = new Array(distributions.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(3, distributions.length) }, async () => {
    while (nextIndex < distributions.length) {
      const index = nextIndex++;
      const distro = distributions[index];
      if (distro)
        enriched[index] = await enrichDistro(distro);
    }
  }));
  const vmMemory = enriched.find((entry) => entry?.distribution.state === "running" && entry.distribution.version === 2 && entry.memoryTotalBytes !== null);
  return {
    supported: true,
    reason: null,
    ...version,
    defaultVersion: statusResult.ok ? parseWslDefaultVersion(statusResult.stdout) : null,
    memoryUsedBytes: vmMemory?.memoryUsedBytes ?? null,
    memoryTotalBytes: vmMemory?.memoryTotalBytes ?? null,
    distributions: enriched.map((entry) => entry?.distribution).filter((entry) => entry !== undefined),
    sampledAt: Date.now(),
    error: versionResult.ok ? null : versionResult.error
  };
};
var readWslDiagnostics = async (name) => {
  if (process.platform !== "win32")
    throw new Error("Le service OpenChamber doit tourner sur Windows pour diagnostiquer WSL.");
  if (!knownName(name))
    throw new Error("Nom de distribution invalide.");
  const snapshot = await readWslSnapshot();
  const distro = snapshot.distributions.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!distro || distro.state !== "running" || distro.version !== 2) {
    throw new Error("Sélectionne une distribution WSL 2 en cours d’exécution.");
  }
  const probe = [
    `if command -v ps >/dev/null 2>&1; then process_rows="$(ps -eo pid=,%cpu=,%mem=,comm= -ww 2>/dev/null | awk '$(NF) != "sh" && $(NF) != "ps" && $(NF) != "awk" && $(NF) != "sort" && $(NF) != "head"')"; printf "__PROCESSES_CPU__\\n"; printf "%s\\n" "$process_rows" | sort -k2,2nr | head -n 100; printf "__PROCESSES_MEMORY__\\n"; printf "%s\\n" "$process_rows" | sort -k3,3nr | head -n 100; else printf "__PROCESSES_CPU__\\n__UNAVAILABLE__\\n__PROCESSES_MEMORY__\\n__UNAVAILABLE__\\n"; fi`,
    `printf "__PORTS__\\n"; if command -v ss >/dev/null 2>&1; then ss -H -lntup 2>/dev/null | awk '{print $1 " " $5 " " $NF}' | head -n 100; else printf "__UNAVAILABLE__\\n"; fi`,
    'printf "__SERVICES__\\n"; if command -v systemctl >/dev/null 2>&1; then service_rows="$(systemctl list-units --type=service --all --no-legend --no-pager --plain --full 2>/dev/null)" && printf "%s\\n" "$service_rows" | head -n 100 || printf "__UNAVAILABLE__\\n"; else printf "__UNAVAILABLE__\\n"; fi',
    'printf "__MOUNTS__\\n"; if command -v findmnt >/dev/null 2>&1; then findmnt --json --list --output SOURCE,TARGET,FSTYPE 2>/dev/null || printf "__UNAVAILABLE__\\n"; else printf "__UNAVAILABLE__\\n"; fi',
    `printf "__NETWORK__\\n"; if command -v ip >/dev/null 2>&1; then printf "ADDRESSES="; hostname -I 2>/dev/null || true; printf "\\nGATEWAY="; ip -4 route show default 2>/dev/null | awk 'NR == 1 {for (i=1;i<NF;i++) if ($i == "via") {print $(i+1); exit}}'; printf "DNS="; awk '$1 == "nameserver" {print $2}' /etc/resolv.conf 2>/dev/null | head -n 8 | tr "\\n" " "; else printf "__UNAVAILABLE__\\n"; fi`
  ].join("; ");
  const result = await runWsl(["--distribution", distro.name, "--exec", "sh", "-c", probe], 1e4);
  if (!result.ok)
    throw new Error(result.error);
  const parsed = parseWslDiagnostics(result.stdout);
  let configuredMode = null;
  try {
    const config = await readWslConfig("global");
    if (config.exists)
      configuredMode = inspectWslConfig(config.text).insights.find((setting) => setting.section === "wsl2" && setting.key === "networkingmode")?.value ?? null;
  } catch {}
  return {
    distro: distro.name,
    ...parsed,
    network: { ...parsed.network, configuredMode },
    sampledAt: Date.now()
  };
};
var catalogCache = null;
var readWslCatalog = async (force = false) => {
  if (process.platform !== "win32")
    return { supported: false, items: [], error: "La liste des distributions WSL est disponible sur Windows." };
  if (!force && catalogCache && catalogCache.expiresAt > Date.now())
    return catalogCache.value;
  const result = await runWsl(["--list", "--online"], 30000);
  const value = result.ok ? { supported: true, items: parseWslCatalog(result.stdout), error: null } : { supported: false, items: [], error: result.error };
  catalogCache = { value, expiresAt: Date.now() + 5 * 60000 };
  return value;
};
var readWslConfig = async (kind, distro) => {
  if (process.platform !== "win32")
    throw new Error("WSL configuration is available when the OpenChamber service runs on Windows.");
  if (kind === "global") {
    const path = join(process.env.USERPROFILE || homedir(), ".wslconfig");
    try {
      return { target: { kind }, exists: true, text: await readFile3(path, "utf8") };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { target: { kind }, exists: false, text: "" };
      throw error;
    }
  }
  if (!distro || !knownName(distro))
    throw new Error("Invalid WSL distribution.");
  const result = await runWsl([
    "--distribution",
    distro,
    "--user",
    "root",
    "--exec",
    "sh",
    "-c",
    'if [ -f /etc/wsl.conf ]; then printf "__EXISTS__\\n"; cat /etc/wsl.conf; else printf "__MISSING__\\n"; fi'
  ]);
  if (!result.ok)
    throw new Error(result.error);
  const marker = result.stdout.indexOf(`__EXISTS__
`);
  if (marker < 0)
    return { target: { kind, distro }, exists: false, text: "" };
  return { target: { kind, distro }, exists: true, text: result.stdout.slice(marker + `__EXISTS__
`.length) };
};
var saveWslConfig = async (update) => {
  if (process.platform !== "win32")
    throw new Error("WSL configuration is available when the OpenChamber service runs on Windows.");
  if (Buffer.byteLength(update.text, "utf8") > 16384 || update.text.includes("\x00"))
    throw new Error("WSL configuration must be at most 16 KB and cannot contain NUL characters.");
  if (update.kind === "global") {
    const path = join(process.env.USERPROFILE || homedir(), ".wslconfig");
    const temporary = join(dirname(path), `.wslconfig.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, update.text, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {
        return;
      });
      throw error;
    }
    return;
  }
  if (!knownName(update.distro))
    throw new Error("Invalid WSL distribution.");
  const encoded = Buffer.from(update.text, "utf8").toString("base64");
  const script = `set -eu
temporary="$(mktemp /etc/wsl.conf.XXXXXX)"
trap 'rm -f "$temporary"' EXIT
printf '%s' "$1" | base64 -d > "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" /etc/wsl.conf
trap - EXIT`;
  const result = await runWsl(["--distribution", update.distro, "--user", "root", "--exec", "sh", "-c", script, "sh", encoded]);
  if (!result.ok)
    throw new Error(result.error);
};
var launchDetached = (command, args) => new Promise((resolve) => {
  const child = spawn2(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.once("error", (error) => resolve({ ok: false, message: cleanError(error.message) }));
  child.once("spawn", () => {
    child.unref();
    resolve({ ok: true, message: "Commande lancée." });
  });
});
var failed = (result) => ({ ok: false, message: result.error });
var success = (message) => ({ ok: true, message });
var pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};
var isKnownDistro = async (name) => {
  const result = await runWsl(["--list", "--verbose"]);
  if (!result.ok)
    return null;
  return parseWslList(result.stdout).some(({ name: installed }) => installed.toLocaleLowerCase() === name.toLocaleLowerCase());
};
var createWslCopy = async (source, newDistro, location, version) => {
  if (await pathExists(location))
    return { ok: false, message: "Le dossier de destination existe déjà. Choisis un nouveau dossier." };
  const parentExists = await lstat(dirname(location)).then((stat) => stat.isDirectory()).catch(() => false);
  if (!parentExists)
    return { ok: false, message: "Le dossier parent doit déjà exister." };
  const alreadyInstalled = await isKnownDistro(newDistro);
  if (alreadyInstalled === null)
    return { ok: false, message: "Impossible de vérifier les distributions déjà installées." };
  if (alreadyInstalled)
    return { ok: false, message: `${newDistro} existe déjà.` };
  const archive = join(dirname(location), `.openchamber-wsl-copy-${randomUUID()}.tar`);
  const exported = await runWsl(["--export", source, archive], 900000);
  if (!exported.ok) {
    await rm(archive, { force: true }).catch(() => {
      return;
    });
    return failed(exported);
  }
  const imported = await runWsl(["--import", newDistro, location, archive, "--version", String(version)], 900000);
  if (!imported.ok)
    return { ok: false, message: `${imported.error} L’archive de secours est conservée ici : ${archive}` };
  try {
    await rm(archive);
  } catch {
    return success(`${newDistro} créée. L’archive temporaire n’a pas pu être supprimée : ${archive}`);
  }
  return success(`${newDistro} créée.`);
};
var distroPortProbe = `awk -F= '/^[[:space:]]*port[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); if ($2 ~ /^[0-9]+$/) {print $2; exit}}' /etc/xrdp/xrdp.ini 2>/dev/null`;
var openDistroTerminal = (distro) => launchDetached("wt.exe", ["-w", "0", "new-tab", "--", wslExe, "--distribution", distro]);
var runWslAction = async (action) => {
  if (process.platform !== "win32")
    return { ok: false, message: "Cette action nécessite le service OpenChamber sur Windows." };
  if ("distro" in action && !knownName(action.distro))
    return { ok: false, message: "Nom de distribution invalide." };
  const run = (args, timeout = 30000) => runWsl(args, timeout);
  switch (action.action) {
    case "start": {
      const result = await openDistroTerminal(action.distro);
      return result.ok ? success(`${action.distro} démarrée dans Windows Terminal.`) : result;
    }
    case "stop": {
      const result = await run(["--terminate", action.distro]);
      return result.ok ? success(`${action.distro} arrêtée.`) : failed(result);
    }
    case "restart": {
      const stop = await run(["--terminate", action.distro]);
      if (!stop.ok)
        return failed(stop);
      const start = await openDistroTerminal(action.distro);
      return start.ok ? success(`${action.distro} redémarrée dans Windows Terminal.`) : start;
    }
    case "set-default": {
      const result = await run(["--set-default", action.distro]);
      return result.ok ? success(`${action.distro} est la distribution par défaut.`) : failed(result);
    }
    case "set-default-version": {
      const result = await run(["--set-default-version", String(action.version)]);
      return result.ok ? success(`WSL ${action.version} sera la version utilisée pour les nouvelles distributions.`) : failed(result);
    }
    case "update-wsl": {
      const result = await run(["--update", "--web-download"], 900000);
      return result.ok ? success("La mise à jour de WSL est terminée. Redémarre WSL si Windows le demande.") : failed(result);
    }
    case "set-version": {
      const result = await run(["--set-version", action.distro, String(action.version)], 600000);
      return result.ok ? success(`${action.distro} convertie en WSL ${action.version}.`) : failed(result);
    }
    case "set-default-user": {
      const target = ["--distribution", action.distro, "--user", "root", "--exec"];
      const userCheck = await run([...target, "id", "-u", action.username]);
      if (!userCheck.ok)
        return failed(userCheck);
      const readConfig = await run([...target, "sh", "-c", "if [ -f /etc/wsl.conf ]; then cat /etc/wsl.conf; fi"]);
      if (!readConfig.ok)
        return failed(readConfig);
      if (Buffer.byteLength(readConfig.stdout, "utf8") > 24 * 1024) {
        return { ok: false, message: "/etc/wsl.conf dépasse la taille prise en charge (24 Ko)." };
      }
      const encodedConfig = Buffer.from(withDefaultWslUser(readConfig.stdout, action.username), "utf8").toString("base64");
      const writeConfig = `set -eu
temporary="$(mktemp /etc/wsl.conf.XXXXXX)"
trap 'rm -f "$temporary"' EXIT
printf '%s' "$1" | base64 -d > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" /etc/wsl.conf
trap - EXIT`;
      const result = await run([...target, "sh", "-c", writeConfig, "sh", encodedConfig]);
      return result.ok ? success(`Utilisateur par défaut configuré pour ${action.distro}. Redémarre la distribution pour appliquer le changement.`) : failed(result);
    }
    case "install": {
      const result = await run(["--install", "--distribution", action.distro, "--no-launch"], 900000);
      return result.ok ? success(`${action.distro} installée.`) : failed(result);
    }
    case "install-from-file": {
      const source = await lstat(action.file).then((stat) => stat.isFile()).catch(() => false);
      if (!source)
        return { ok: false, message: "Le paquet WSL est introuvable ou n’est pas un fichier." };
      if (await pathExists(action.location))
        return { ok: false, message: "Le dossier d’installation existe déjà. Choisis un nouveau dossier." };
      const result = await run([
        "--install",
        "--from-file",
        action.file,
        "--name",
        action.distro,
        "--location",
        action.location,
        "--version",
        String(action.version),
        "--no-launch"
      ], 900000);
      return result.ok ? success(`${action.distro} installée depuis le paquet local.`) : failed(result);
    }
    case "export": {
      if (await pathExists(action.file))
        return { ok: false, message: "Le fichier cible existe déjà. Choisis un nouveau chemin pour ne pas l’écraser." };
      const result = await run(action.format === "vhd" ? ["--export", action.distro, action.file, "--vhd"] : ["--export", action.distro, action.file], 900000);
      return result.ok ? success(`Archive exportée vers ${action.file}.`) : failed(result);
    }
    case "import": {
      if (await pathExists(action.location))
        return { ok: false, message: "Le dossier d’installation existe déjà. Choisis un nouveau dossier vide." };
      const source = await lstat(action.file).then((stat) => stat.isFile()).catch(() => false);
      if (!source)
        return { ok: false, message: "L’archive d’import est introuvable ou n’est pas un fichier." };
      const args = ["--import", action.distro, action.location, action.file, "--version", String(action.version)];
      if (action.format === "vhd")
        args.push("--vhd");
      const result = await run(args, 900000);
      return result.ok ? success(`${action.distro} importée.`) : failed(result);
    }
    case "import-in-place": {
      const source = await lstat(action.file).then((stat) => stat.isFile()).catch(() => false);
      if (!source)
        return { ok: false, message: "Le fichier VHDX est introuvable ou n’est pas un fichier." };
      const result = await run(["--import-in-place", action.distro, action.file], 900000);
      return result.ok ? success(`${action.distro} enregistrée depuis le disque VHDX.`) : failed(result);
    }
    case "clone": {
      if (!knownName(action.newDistro))
        return { ok: false, message: "Nom de la nouvelle distribution invalide." };
      const copied = await createWslCopy(action.distro, action.newDistro, action.location, action.version);
      return copied.ok ? success(`${action.distro} clonée sous ${action.newDistro}.`) : copied;
    }
    case "rename": {
      if (!knownName(action.newDistro) || action.newDistro.toLocaleLowerCase() === action.distro.toLocaleLowerCase()) {
        return { ok: false, message: "Le nouveau nom de distribution est invalide ou identique à l’ancien." };
      }
      const copied = await createWslCopy(action.distro, action.newDistro, action.location, action.version);
      if (!copied.ok)
        return copied;
      const unregister = await run(["--unregister", action.distro], 120000);
      if (!unregister.ok) {
        return { ok: false, message: `${action.newDistro} a été créée, mais ${action.distro} n’a pas pu être désinscrite. Les deux distributions restent disponibles. ${unregister.error}` };
      }
      return success(`${action.distro} renommée en ${action.newDistro}.`);
    }
    case "move": {
      if (await pathExists(action.location))
        return { ok: false, message: "Le dossier de destination existe déjà. Choisis un nouveau dossier." };
      const result = await run(["--manage", action.distro, "--move", action.location], 900000);
      return result.ok ? success(`${action.distro} déplacée.`) : failed(result);
    }
    case "resize": {
      const shutdown = await run(["--shutdown"], 120000);
      if (!shutdown.ok)
        return failed(shutdown);
      const result = await run(["--manage", action.distro, "--resize", action.size], 600000);
      return result.ok ? success(`${action.distro} redimensionnée. Les distributions WSL ont été arrêtées.`) : failed(result);
    }
    case "compact": {
      const trim = await run(["--distribution", action.distro, "--user", "root", "--exec", "fstrim", "-av"], 120000);
      if (!trim.ok)
        return { ok: false, message: `Impossible de libérer les blocs inutilisés avant la compaction : ${trim.error}` };
      const shutdown = await run(["--shutdown"], 120000);
      if (!shutdown.ok)
        return failed(shutdown);
      const result = await run(["--manage", action.distro, "--compact"], 600000);
      return result.ok ? success(`${action.distro} compactée. Les distributions WSL ont été arrêtées.`) : failed(result);
    }
    case "set-sparse": {
      const result = await run(["--manage", action.distro, "--set-sparse", String(action.enabled)]);
      return result.ok ? success(`Mode sparse ${action.enabled ? "activé" : "désactivé"} pour ${action.distro}.`) : failed(result);
    }
    case "shutdown": {
      const result = await run(["--shutdown"], 120000);
      return result.ok ? success("Toutes les distributions WSL ont été arrêtées.") : failed(result);
    }
    case "force-shutdown": {
      const result = await run(["--shutdown", "--force"], 120000);
      return result.ok ? success("Arrêt forcé de WSL terminé.") : failed(result);
    }
    case "unregister": {
      const result = await run(["--unregister", action.distro], 120000);
      return result.ok ? success(`${action.distro} désinscrite et données de distribution supprimées.`) : failed(result);
    }
    case "open-terminal":
      return openDistroTerminal(action.distro);
    case "open-files":
      return launchDetached(join(root, "explorer.exe"), [`\\\\wsl.localhost\\${action.distro}\\`]);
    case "open-vscode":
      return launchDetached("code.exe", ["--remote", `wsl+${action.distro}`, "/home"]);
    case "open-rdp": {
      const portResult = await run(["--distribution", action.distro, "--exec", "sh", "-c", distroPortProbe], 1e4);
      if (!portResult.ok)
        return failed(portResult);
      const port = Number(portResult.stdout.trim().split(`
`).at(-1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, message: "Aucun port xrdp valide n’a été détecté dans /etc/xrdp/xrdp.ini." };
      }
      return launchDetached(join(root, "System32", "mstsc.exe"), ["/v:localhost:" + port]);
    }
  }
};

// src/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var platform = currentPlatform();
var container = await detectContainer(platform);
var now = () => Date.now();
var settings = structuredClone(DEFAULT_MONITOR_SETTINGS);
var processCollector = createProcessCollector(platform, now);
var diskActivity = createDiskActivityCollector(platform, now);
var wslJobs = new Map;
var pruneWslJobs = () => {
  const cutoff = Date.now() - 30 * 60000;
  for (const [id, job] of wslJobs) {
    if (job.state !== "running" && (job.finishedAt ?? job.startedAt) < cutoff)
      wslJobs.delete(id);
  }
};
var sampler = createSampler({
  now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  platform,
  container,
  cpuMem: createCpuMemCollector(platform, container, now),
  gpu: createGpuCollector(platform),
  disks: () => readDisks(platform, container),
  diskActivity,
  computerInfo: () => readComputerInfo(platform),
  network: () => readNetwork(platform, now()),
  processes: (limit) => processCollector.read(limit),
  battery: () => readBattery(platform),
  sensors: () => readSensors(platform),
  settings: () => settings
});
var send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
var readJsonBody = (req) => new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  let failed = false;
  req.on("data", (chunk) => {
    if (failed)
      return;
    size += chunk.length;
    if (size > 32768) {
      failed = true;
      resolve(null);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (failed)
      return;
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      resolve(null);
    }
  });
  req.on("error", () => resolve(null));
});
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
  if (pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (pathname === "/stats" && req.method === "GET") {
    sampler.stats().then((stats) => send(res, 200, stats), () => send(res, 503, { error: "not-ready" }));
    return;
  }
  if (pathname === "/settings" && req.method === "POST") {
    readJsonBody(req).then((value) => {
      if (value === null) {
        send(res, 400, { error: "invalid-settings" });
        return;
      }
      const next = normalizeMonitorSettings(value);
      const wasPaused = settings.paused;
      settings = next;
      if (next.paused && !wasPaused)
        sampler.pause();
      else if (!next.paused && wasPaused)
        sampler.resume();
      send(res, 200, { ok: true });
    });
    return;
  }
  if (pathname === "/wsl" && req.method === "GET") {
    readWslSnapshot().then((snapshot) => send(res, 200, snapshot), () => send(res, 503, { error: "wsl-unavailable" }));
    return;
  }
  if (pathname === "/wsl/diagnostics" && req.method === "GET") {
    const distro = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("distro") ?? "";
    readWslDiagnostics(distro).then((diagnostics) => send(res, 200, diagnostics), (error) => send(res, 400, { error: error instanceof Error ? error.message : "WSL diagnostics unavailable." }));
    return;
  }
  if (pathname === "/wsl/catalog" && req.method === "GET") {
    readWslCatalog(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("refresh") === "1").then((catalog) => send(res, 200, catalog), () => send(res, 503, { supported: false, items: [], error: "La liste des distributions WSL est indisponible." }));
    return;
  }
  if (pathname === "/wsl/config" && req.method === "GET") {
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const kind = query.get("kind") === "distribution" ? "distribution" : "global";
    const distro = query.get("distro") ?? undefined;
    readWslConfig(kind, distro).then((document) => send(res, 200, document), (error) => send(res, 400, { error: error instanceof Error ? error.message : "WSL configuration unavailable." }));
    return;
  }
  if (pathname === "/wsl/config" && req.method === "POST") {
    readJsonBody(req).then(async (value) => {
      const update = parseWslConfigUpdate(value);
      if (!update) {
        send(res, 400, { ok: false, message: "WSL configuration is invalid or its typed confirmation is missing." });
        return;
      }
      try {
        await saveWslConfig(update);
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, message: error instanceof Error ? error.message : "Could not save WSL configuration." });
      }
    });
    return;
  }
  if (pathname === "/wsl/action" && req.method === "POST") {
    readJsonBody(req).then((value) => {
      const action = parseWslAction(value);
      if (!action) {
        send(res, 400, { ok: false, message: "Action WSL invalide ou confirmation manquante." });
        return;
      }
      pruneWslJobs();
      if ([...wslJobs.values()].filter((job) => job.state === "running").length >= 3) {
        send(res, 429, { ok: false, message: "Trop d’opérations WSL sont déjà en cours." });
        return;
      }
      const id = randomUUID2();
      const job = { id, action: action.action, state: "running", message: "Opération en cours.", startedAt: Date.now(), finishedAt: null };
      wslJobs.set(id, job);
      send(res, 202, job);
      runWslAction(action).then((result) => {
        job.state = result.ok ? "succeeded" : "failed";
        job.message = result.message;
        job.finishedAt = Date.now();
      }, () => {
        job.state = "failed";
        job.message = "L’opération WSL a échoué.";
        job.finishedAt = Date.now();
      });
    });
    return;
  }
  const wslJobMatch = pathname.match(/^\/wsl\/jobs\/([0-9a-f-]{36})$/i);
  if (wslJobMatch && req.method === "GET") {
    const job = wslJobs.get(wslJobMatch[1] ?? "");
    send(res, job ? 200 : 404, job ?? { error: "not-found" });
    return;
  }
  if (pathname === "/open-storage-settings" && req.method === "POST" && platform === "win32") {
    runPowerShell("Start-Process 'ms-settings:storage'", 5000).then((result) => send(res, result.ok ? 200 : 500, { opened: result.ok }));
    return;
  }
  send(res, 404, { error: "not-found" });
});
var shutdown = () => {
  sampler.stop();
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
