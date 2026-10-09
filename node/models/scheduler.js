import { syncModels } from './service.js';

let timer;
let running;
let state = {
  running: false,
  source: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  result: null,
};

export const getModelSyncState = () => ({ ...state });

export function runModelSync(source = 'manual') {
  if (running) return running;
  state = { ...state, running: true, source, startedAt: new Date(), lastError: null };
  running = syncModels()
    .then((result) => {
      state = { ...state, result, finishedAt: new Date() };
      return result;
    })
    .catch((error) => {
      state = { ...state, lastError: error.message, finishedAt: new Date() };
      throw error;
    })
    .finally(() => {
      state.running = false;
      running = null;
    });
  return running;
}

/** 固定北京时间每日 04:00，不依赖部署主机时区。 */
export function nextModelSyncTime(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let next =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 4) -
    8 * 60 * 60 * 1000;
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1000;
  return new Date(next);
}

export function startModelSyncScheduler() {
  if (timer) return;
  const schedule = () => {
    timer = setTimeout(() => {
      schedule();
      void runModelSync('scheduler').catch((error) =>
        console.error('[models] 同步失败:', error.message),
      );
    }, nextModelSyncTime().getTime() - Date.now());
    timer.unref?.();
  };
  schedule();
  return () => {
    clearTimeout(timer);
    timer = null;
  };
}
