import { useState, useEffect, useCallback } from 'react';
import type { FontCatalog, FontItem, Clip } from './types';

const loadedFamilies = new Set<string>();

/**
 * Load a font file into the browser runtime using FontFace API.
 */
export async function loadFontFile(family: string, filePath: string): Promise<boolean> {
  if (loadedFamilies.has(family)) return true;

  try {
    const toMediaUrl = (window as any).api?.toMediaUrl;
    const url = toMediaUrl
      ? toMediaUrl(filePath)
      : 'media://local/' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');

    const face = new FontFace(family, `url("${url}")`);
    const loaded = await face.load();
    document.fonts.add(loaded);
    loadedFamilies.add(family);
    window.dispatchEvent(new CustomEvent('cutline:fonts-updated'));
    return true;
  } catch (err) {
    console.warn(`[fontManager] failed to load font "${family}" from ${filePath}:`, err);
    return false;
  }
}

/**
 * Global cache of available fonts.
 */
let cachedCatalog: FontCatalog = {
  capcut: [],
  system: [
    { id: 'sys_impact', name: 'Impact', family: 'Impact', category: 'system' },
    { id: 'sys_bahnschrift', name: 'Bahnschrift', family: 'Bahnschrift', category: 'system' },
    { id: 'sys_segoe_ui', name: 'Segoe UI', family: 'Segoe UI', category: 'system' },
    { id: 'sys_arial', name: 'Arial', family: 'Arial', category: 'system' },
    { id: 'sys_arial_black', name: 'Arial Black', family: 'Arial Black', category: 'system' },
    { id: 'sys_calibri', name: 'Calibri', family: 'Calibri', category: 'system' },
    { id: 'sys_comic_sans', name: 'Comic Sans MS', family: 'Comic Sans MS', category: 'system' },
    { id: 'sys_georgia', name: 'Georgia', family: 'Georgia', category: 'system' },
    { id: 'sys_times', name: 'Times New Roman', family: 'Times New Roman', category: 'system' },
    { id: 'sys_trebuchet', name: 'Trebuchet MS', family: 'Trebuchet MS', category: 'system' },
    { id: 'sys_verdana', name: 'Verdana', family: 'Verdana', category: 'system' }
  ],
  custom: [],
  all: []
};

/**
 * Load all file-based fonts (CapCut and Custom) in the background so they are ready for canvas rendering.
 */
export async function preloadFonts(catalog: FontCatalog): Promise<void> {
  const fileFonts = [...(catalog.capcut || []), ...(catalog.custom || [])];
  await Promise.allSettled(
    fileFonts.map(async (f) => {
      if (f.path) {
        await loadFontFile(f.family, f.path);
      }
    })
  );
}

/**
 * Ensure a font required by a clip's style is loaded.
 */
export async function ensureClipFontLoaded(clip: Clip, catalog?: FontCatalog): Promise<void> {
  const family = clip.style?.fontFamily;
  if (!family || loadedFamilies.has(family)) return;

  const currentCat = catalog || cachedCatalog;
  const found = currentCat.all.find((f) => f.family === family || f.name === family);
  if (found && found.path) {
    await loadFontFile(found.family, found.path);
  }
}

/**
 * React hook to get and manage available fonts.
 */
export function useFonts() {
  const [catalog, setCatalog] = useState<FontCatalog>(cachedCatalog);
  const [loading, setLoading] = useState(false);

  const fetchFonts = useCallback(async () => {
    if (!window.api?.getAvailableFonts) return;
    try {
      setLoading(true);
      const res = await window.api.getAvailableFonts();
      if (res && res.all) {
        cachedCatalog = res;
        setCatalog(res);
        // Preload CapCut and custom fonts in background
        preloadFonts(res);
      }
    } catch (e) {
      console.error('[useFonts] error fetching fonts:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const importCustom = useCallback(async () => {
    if (!window.api?.importCustomFonts) return;
    try {
      setLoading(true);
      const res = await window.api.importCustomFonts();
      if (!res.canceled && res.fonts) {
        cachedCatalog = res.fonts;
        setCatalog(res.fonts);
        await preloadFonts(res.fonts);
      }
    } catch (e) {
      console.error('[useFonts] error importing custom font:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFonts();
  }, [fetchFonts]);

  return {
    catalog,
    loading,
    refreshFonts: fetchFonts,
    importCustom
  };
}
