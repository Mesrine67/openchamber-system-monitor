import type { HealthSummary, Stats } from './stats.ts';

const missing = (source: Stats['cpu'] | Stats['memory'] | Stats['disks']): boolean =>
  source.status === 'unavailable' && source.reason !== 'no-device';

/** One health calculation shared by the rail, Work Status, and dashboard. */
export const evaluateHealth = (stats: Pick<Stats, 'cpu' | 'memory' | 'gpus' | 'disks' | 'network' | 'processes' | 'battery' | 'sensors' | 'warnings'>): HealthSummary => {
  const criticalCount = stats.warnings.filter((warning) => warning.level === 'critical').length;
  const warningCount = stats.warnings.length;
  // Optional modules can be unsupported without making an otherwise healthy
  // machine look unhealthy. The three core sources determine full unavailability.
  const unavailableCount = [stats.cpu, stats.memory, stats.disks].filter(missing).length;
  const coreUnavailable = unavailableCount === 3;

  return {
    state: coreUnavailable ? 'unavailable' : criticalCount > 0 ? 'critical' : warningCount > 0 ? 'attention' : 'healthy',
    warningCount,
    criticalCount,
    unavailableCount,
  };
};
