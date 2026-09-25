import type { Clip, MediaItem, Track } from './types';

export interface ProjectSettings { width: number; height: number; fps: number }
export interface ProjectDocument {
  format: 'cutline-project';
  version: 1;
  name: string;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  settings: ProjectSettings;
}
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  clipCount: number;
  cover?: string;
  filePath?: string;
  size?: number;
}

export interface ProjectApi {
  saveProject(data: ProjectDocument, path?: string | null, saveAs?: boolean): Promise<{ok: boolean; path?: string; error?: string; canceled?: boolean}>;
  openProject(): Promise<{ok: boolean; data?: ProjectDocument; path?: string; error?: string; canceled?: boolean}>;
  openProjectPath?(path: string): Promise<{ok: boolean; data?: ProjectDocument; path?: string; error?: string}>;
  autosaveProject(data: ProjectDocument, path?: string | null): Promise<{ok: boolean; error?: string}>;
  restoreProject(): Promise<{data: ProjectDocument; path?: string | null; dirty?:boolean} | null>;

  listProjects(): Promise<{ ok: boolean; projects?: ProjectMeta[]; error?: string }>;
  openProjectById(id: string): Promise<{ ok: boolean; id?: string; data?: ProjectDocument; error?: string }>;
  createProject(name?: string): Promise<{ ok: boolean; id?: string; data?: ProjectDocument; meta?: ProjectMeta; error?: string }>;
  autosaveProjectById(id: string, payload: ProjectDocument, metaPatch?: { duration?: number; cover?: string }): Promise<{ ok: boolean; error?: string }>;
  duplicateProject(id: string): Promise<{ ok: boolean; id?: string; meta?: ProjectMeta; error?: string }>;
  deleteProject(id: string): Promise<{ ok: boolean; error?: string }>;
  renameProjectById(id: string, name: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  showProjectInFolder(id: string): Promise<{ ok: boolean; error?: string }>;
  getActiveProjectId(): Promise<{ ok: boolean; id?: string | null; error?: string }>;
}
