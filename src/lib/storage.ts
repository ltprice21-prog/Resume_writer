"use client";

import { MASTER_RESUME } from "./resume";
import type { MasterResume, TailorResponse } from "./types";

const MASTER_KEY = "resume-writer:master";
const HISTORY_KEY = "resume-writer:history";
const HISTORY_LIMIT = 25;

/**
 * Everything lives in the browser: there is no database and no server-side
 * storage of resumes or job descriptions. Clearing site data resets the app to
 * the master resume checked into src/lib/resume.ts.
 */
export function loadMaster(): MasterResume {
  if (typeof window === "undefined") return MASTER_RESUME;
  try {
    const raw = window.localStorage.getItem(MASTER_KEY);
    if (!raw) return MASTER_RESUME;
    const parsed = JSON.parse(raw) as MasterResume;
    if (!parsed || !Array.isArray(parsed.roles) || parsed.roles.length === 0) {
      return MASTER_RESUME;
    }
    return parsed;
  } catch {
    return MASTER_RESUME;
  }
}

export function saveMaster(master: MasterResume): void {
  window.localStorage.setItem(MASTER_KEY, JSON.stringify(master));
}

export function resetMaster(): void {
  window.localStorage.removeItem(MASTER_KEY);
}

export type HistoryEntry = TailorResponse & { jobDescriptionPreview: string };

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addToHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...loadHistory()].slice(0, HISTORY_LIMIT);
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function clearHistory(): HistoryEntry[] {
  window.localStorage.removeItem(HISTORY_KEY);
  return [];
}
