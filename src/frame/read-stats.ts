import type { Stats } from '../shared/stats.ts';

// Boundary check for the service answer. The service is ours, so this guards
// against a mismatched version (old service, new frame) rather than an attacker:
// enough structure for the views to render without throwing.

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const field = (value: object, key: string): unknown => Reflect.get(value, key);

const isSource = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const status = field(value, 'status');
  return status === 'ok' || (status === 'unavailable' && typeof field(value, 'reason') === 'string');
};

const isSeries = (value: unknown): value is (number | null)[] =>
  Array.isArray(value) && value.every((point) => point === null || typeof point === 'number');

const hasArray = (value: unknown, key: string): boolean =>
  isObject(value) && (field(value, 'status') !== 'ok' || Array.isArray(field(value, key)));

export const isStats = (value: unknown): value is Stats => {
  if (!isObject(value) || typeof field(value, 'sampledAt') !== 'number') return false;
  const environment = field(value, 'environment');
  const history = field(value, 'history');
  return isObject(environment)
    && typeof field(environment, 'container') === 'boolean'
    && ['cpu', 'memory', 'gpus', 'disks'].every((key) => isSource(field(value, key)))
    && hasArray(field(value, 'cpu'), 'perCore')
    && hasArray(field(value, 'gpus'), 'devices')
    && hasArray(field(value, 'disks'), 'items')
    && isObject(history)
    && isSeries(field(history, 'cpu'))
    && isSeries(field(history, 'gpu'))
    && Array.isArray(field(value, 'warnings'));
};

export const readStats = (body: string): Stats | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    return isStats(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
