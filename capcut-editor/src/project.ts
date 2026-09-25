import { useEditor } from './store';
import type { ProjectApi, ProjectMeta } from './project-types';

const api = () => window.api as typeof window.api & ProjectApi;

export async function saveProject(saveAs = false) {
  const s = useEditor.getState(), data = s.snapshotProject();
  const res = await api().saveProject(data, s.projectPath, saveAs);
  if (res.ok && res.path) { s.markSaved(res.path, data); await flushDraft(); }
  else if (res.error) throw new Error(res.error);
  return res.ok;
}

export async function flushDraft() {
  const s = useEditor.getState();
  // Don't autosave empty untouched projects with 0 clips and 0 media
  if (s.clips.length === 0 && s.media.length === 0) {
    return;
  }
  const doc = s.snapshotProject();
  const firstMedia = s.media.find(m => m.kind === 'image' || m.kind === 'video');
  const cover = firstMedia
    ? (firstMedia.kind === 'image' ? (window.api.toMediaUrl ? window.api.toMediaUrl(firstMedia.path) : firstMedia.path) : (firstMedia.thumbs?.[0] || ''))
    : '';
  const duration = s.duration();

  if (s.currentProjectId && api().autosaveProjectById) {
    try {
      await api().autosaveProjectById(s.currentProjectId, doc, { duration, cover });
    } catch {}
  }
  const result = await api().autosaveProject(doc, s.projectPath);
  if (!result.ok && !s.currentProjectId) throw new Error(result.error || 'Could not save draft.');
}

export async function openProject() {
  const res = await api().openProject();
  if (res.ok && res.data) {
    useEditor.getState().loadProject(res.data, res.path);
    await flushDraft();
  }
  else if (res.error) throw new Error(res.error);
}

export async function switchToProject(id: string) {
  try { await flushDraft(); } catch {}
  const res = await api().openProjectById(id);
  if (res.ok && res.data) {
    useEditor.getState().loadProject(res.data, null, res.id);
  } else if (res.error) {
    throw new Error(res.error);
  }
}

export async function createNewProject(name?: string) {
  try { await flushDraft(); } catch {}
  const res = await api().createProject(name);
  if (res.ok && res.data) {
    useEditor.getState().loadProject(res.data, null, res.id);
    return res;
  } else if (res.error) {
    throw new Error(res.error);
  }
  return res;
}

export async function listAllProjects(): Promise<ProjectMeta[]> {
  const res = await api().listProjects();
  if (res.ok && res.projects) return res.projects;
  return [];
}

export async function duplicateProject(id: string) {
  return await api().duplicateProject(id);
}

export async function deleteProject(id: string) {
  return await api().deleteProject(id);
}

export async function renameProject(id: string, newName: string) {
  return await api().renameProjectById(id, newName);
}

export async function showProjectInFolder(id: string) {
  return await api().showProjectInFolder(id);
}

export async function restoreProject() {
  try {
    const active = await api().getActiveProjectId?.();
    if (active?.ok && active.id) {
      const res = await api().openProjectById(active.id);
      if (res.ok && res.data) {
        useEditor.getState().loadProject(res.data, null, res.id);
        return;
      }
    }
  } catch {}

  const draft = await api().restoreProject();
  if (draft) {
    useEditor.getState().loadProject(draft.data, draft.path);
    useEditor.setState({ dirty: draft.dirty ?? true });
  } else {
    // Create first project if brand new
    try {
      await createNewProject('Миний төсөл 1');
    } catch {}
  }
}

export function startProjectAutosave(onError: (message: string) => void) {
  let timer: ReturnType<typeof setTimeout>;
  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (
      s.media === prev.media &&
      s.clips === prev.clips &&
      s.tracks === prev.tracks &&
      s.projectName === prev.projectName &&
      s.projectSettings === prev.projectSettings
    ) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flushDraft().catch((e) => onError(String(e.message)));
    }, 600);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
