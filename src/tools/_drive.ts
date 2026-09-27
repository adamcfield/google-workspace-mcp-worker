/**
 * Drive helpers shared by the Drive, Sheets, Docs and Slides tools (one place to fix
 * query escaping and the "move into folder" sequence).
 */
import { API, type GoogleClient } from "../google/client.js";
import { enc, type AnyRec } from "./_shared.js";

/** Drive query literal escaping: backslash is the escape char, then single quotes. */
export const escapeDriveQuery = (s: string): string => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Heuristic: a raw Drive query has an operator AND a quoted literal; anything else is free text. */
export const looksLikeRawQuery = (q: string): boolean => /(\bcontains\b|=|!=|\bin\b|\bhas\b|\btrashed\b)/.test(q) && /'/.test(q);

/** Free text → `(name contains 'x' or fullText contains 'x')`; raw queries pass through parenthesised. */
export const driveTextQuery = (q: string): string => (looksLikeRawQuery(q) ? `(${q})` : `(name contains '${escapeDriveQuery(q)}' or fullText contains '${escapeDriveQuery(q)}')`);

/**
 * Move a file into `folderId`. Drive files have exactly one parent, so every current
 * parent (except the destination) is removed. Returns the file's new parents.
 */
export async function moveToFolder(g: GoogleClient, fileId: string, folderId: string): Promise<{ id: string; name?: string; parents: string[] }> {
  const meta = await g.get<AnyRec>(`${API.drive}/files/${enc(fileId)}`, { fields: "id,parents", supportsAllDrives: true });
  const current: string[] = meta.parents ?? [];
  const removeParents = current.filter((p) => p !== folderId).join(",") || undefined;
  const r = await g.patch<AnyRec>(`${API.drive}/files/${enc(fileId)}`, {}, { addParents: folderId, removeParents, supportsAllDrives: true, fields: "id,name,parents" });
  return { id: String(r.id ?? fileId), name: r.name, parents: r.parents ?? [folderId] };
}
