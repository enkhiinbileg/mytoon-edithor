import type { WaveformData } from '../types';

const waveformCache = new Map<string, WaveformData>();
const pendingRequests = new Map<string, Promise<WaveformData | null>>();
const subscribers = new Set<(filePath: string, data: WaveformData) => void>();

/**
 * Subscribe to waveform updates. Callback is called when a waveform is loaded.
 */
export function subscribeWaveform(cb: (filePath: string, data: WaveformData) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Get cached waveform data synchronously if available.
 */
export function getCachedWaveform(filePath: string): WaveformData | null {
  if (!filePath) return null;
  return waveformCache.get(filePath) || null;
}

/**
 * Request waveform data for a file. Returns cached data if ready,
 * otherwise requests from backend via IPC and caches the result.
 */
export async function requestWaveform(filePath: string): Promise<WaveformData | null> {
  if (!filePath) return null;

  const cached = waveformCache.get(filePath);
  if (cached) return cached;

  const inFlight = pendingRequests.get(filePath);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      if (window.api?.waveform) {
        const res = await window.api.waveform(filePath);
        if (res && res.ok && Array.isArray(res.peaks)) {
          waveformCache.set(filePath, res);
          subscribers.forEach((cb) => cb(filePath, res));
          return res;
        }
      }
    } catch (err) {
      console.warn('[WaveformService] Failed to load waveform for:', filePath, err);
    } finally {
      pendingRequests.delete(filePath);
    }
    return null;
  })();

  pendingRequests.set(filePath, promise);
  return promise;
}
