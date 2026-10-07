// src/service/main.ts
import http from "node:http";

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
        const used2 = parseVmStat(vm.stdout);
        if (used2 === null)
          return unavailable("failed");
        return {
          status: "ok",
          used: used2,
          total: os.totalmem(),
          available: Math.max(0, os.totalmem() - used2),
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
    const path2 = `/sys/class/power_supply/${device}`;
    const [type, online] = await Promise.all([readText(`${path2}/type`), readText(`${path2}/online`)]);
    if (type?.trim() === "Battery")
      candidates.push(path2);
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
      ...driveType === 2 ? { driveType: "removable" } : driveType === 3 ? { driveType: "fixed" } : {}
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
var WINDOWS_DISKS = 'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem, DriveType | ConvertTo-Json -Compress';
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
  const number2 = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number2) && number2 >= 0 ? number2 : null;
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
  const number2 = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number2) && number2 >= 0 ? number2 : null;
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
      receivedIndex = fields.findIndex((field2) => field2.toLowerCase() === "ibytes");
      sentIndex = fields.findIndex((field2) => field2.toLowerCase() === "obytes");
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
  const number2 = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number2) && number2 >= 0 ? number2 : null;
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
  const name = safeName(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !name || userTicks === null || systemTicks === null)
    return null;
  return { pid, name, cpuTicks: userTicks + systemTicks };
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
    if (pid === null || pid <= 0 || !name)
      continue;
    result.push({ pid, name, cpuPercent, memoryBytes });
  }
  return result.slice(0, limit);
};
var parsePsProcesses = (text, limit = 20) => {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4])
      continue;
    const pid = Number(match[1]);
    const name = safeName(match[2]);
    const cpuPercent = Number(match[3]);
    const rssKib = Number(match[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || !Number.isFinite(cpuPercent) || !Number.isSafeInteger(rssKib))
      continue;
    result.push({ pid, name, cpuPercent: Math.max(0, cpuPercent), memoryBytes: Math.max(0, rssKib) * 1024 });
  }
  return result.slice(0, limit);
};
var rankProcesses = (entries, limit) => ({
  topCpu: [...entries].filter((item) => item.cpuPercent !== null).sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)).slice(0, limit),
  topMemory: [...entries].filter((item) => item.memoryBytes !== null).sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)).slice(0, limit)
});

// src/service/collectors/processes.ts
var WINDOWS_PROCESSES = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' } | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSetPrivate)
$cpu = @($rows | Sort-Object { [double]$_.PercentProcessorTime } -Descending | Select-Object -First 20)
$mem = @($rows | Sort-Object { [double]$_.WorkingSetPrivate } -Descending | Select-Object -First 20)
@{ topCpu = $cpu; topMemory = $mem } | ConvertTo-Json -Compress -Depth 3
`;
var createProcessCollector = (platform, now) => {
  let previousCpuTicks = null;
  let previousSystemTicks = null;
  const readLinux = async (limit) => {
    let pids;
    try {
      pids = (await readdir4("/proc")).filter((name) => /^\d+$/.test(name)).slice(0, 2048);
    } catch {
      return unavailable("failed");
    }
    const systemTicks = parseLinuxTotalCpuTicks(await readText("/proc/stat") ?? "");
    if (systemTicks === null)
      return unavailable("failed");
    const current = [];
    for (let offset = 0;offset < pids.length; offset += 64) {
      const chunk = await Promise.all(pids.slice(offset, offset + 64).map(async (pidText) => {
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
      return { pid: item.pid, name: item.name, cpuPercent, memoryBytes: item.memoryBytes };
    });
    previousCpuTicks = new Map(current.map((item) => [item.pid, item.cpuTicks]));
    previousSystemTicks = systemTicks;
    const ranked = rankProcesses(entries, limit);
    return { status: "ok", ...ranked, sampledAt: now() };
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
      if (cpu === null || memory === null)
        return unavailable("failed");
      const union = new Map;
      for (const item of [...cpu, ...memory])
        union.set(item.pid, { ...union.get(item.pid), ...item });
      const ranked = rankProcesses([...union.values()], limit);
      return { status: "ok", ...ranked, sampledAt: now() };
    }
    if (platform === "darwin") {
      const result = await run(["/bin/ps", "ps"], ["-Ao", "pid=,comm=,%cpu=,rss="]);
      if (!result.ok)
        return unavailable(result.missing ? "tool-missing" : "failed", "ps");
      entries = parsePsProcesses(result.stdout, 2048);
      if (entries === null)
        return unavailable("failed");
      const ranked = rankProcesses(entries, limit);
      return { status: "ok", ...ranked, sampledAt: now() };
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
var sustainedHigh = (history, threshold2 = WARN_PERCENT, seconds = 60) => {
  const required = Math.max(1, Math.ceil(seconds * 1000 / SAMPLE_INTERVAL_MS));
  if (history.length < required)
    return false;
  return history.slice(-required).every((value) => value !== null && value >= threshold2);
};
var levelAt = (percent2, warning, critical) => percent2 >= critical ? "critical" : percent2 >= warning ? "warn" : null;
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
      const percent2 = diskPercent(disk);
      if (percent2 === null)
        continue;
      const level = levelAt(percent2, thresholds.diskWarning, thresholds.diskCritical);
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
    if (size > 16384) {
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
