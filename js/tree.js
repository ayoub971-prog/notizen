// Reine Funktionen fuer die Ordnerstruktur (ohne Datenbank, gut testbar).
// Ein Ordner: { id, name, parentId (null = oberste Ebene), created }

const byName = (a, b) => a.name.localeCompare(b.name, 'de-CH', { sensitivity: 'base', numeric: true });

export function childrenOf(folders, parentId) {
  return folders.filter((f) => (f.parentId ?? null) === (parentId ?? null)).sort(byName);
}

/** Flache Liste fuer die Anzeige: [{ folder, depth, hasChildren }] (collapsed: Set eingeklappter IDs). */
export function flattenTree(folders, collapsed = new Set()) {
  const out = [];
  const walk = (pid, depth) => {
    for (const f of childrenOf(folders, pid)) {
      const hasChildren = folders.some((x) => x.parentId === f.id);
      out.push({ folder: f, depth, hasChildren });
      if (!collapsed.has(f.id)) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function pathOf(folders, id) {
  const names = [];
  const seen = new Set();
  let f = folders.find((x) => x.id === id);
  while (f && !seen.has(f.id)) { seen.add(f.id); names.unshift(f.name); f = folders.find((x) => x.id === f.parentId); }
  return names;
}

/** Ordner selbst + alle Unterordner (beliebig tief). */
export function descendantIds(folders, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const f of folders) if (f.parentId === ids[i] && !ids.includes(f.id)) ids.push(f.id);
  return ids;
}

/** Darf Ordner `id` nach `newParentId` verschoben werden? (nicht in sich selbst/Unterordner) */
export function canMoveFolder(folders, id, newParentId) {
  if (newParentId == null) return true;
  return !descendantIds(folders, id).includes(newParentId);
}

export function moveFolder(folders, id, newParentId) {
  if (!canMoveFolder(folders, id, newParentId)) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden.');
  return folders.map((f) => (f.id === id ? { ...f, parentId: newParentId ?? null } : f));
}

/** Was wird geloescht? -> { folderIds, noteIds } (Notizen kommen in den Papierkorb). */
export function planDeleteFolder(folders, notes, id) {
  const folderIds = descendantIds(folders, id);
  const set = new Set(folderIds);
  const noteIds = notes.filter((n) => !n.deleted && set.has(n.folderId)).map((n) => n.id);
  return { folderIds, noteIds };
}

/** Prueft einen Ordnernamen. Gibt { ok, name, error } zurueck. */
export function validateFolderName(folders, name, parentId, exceptId) {
  const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  if (!clean) return { ok: false, error: 'Bitte einen Namen eingeben.' };
  const dup = folders.some((f) => f.id !== exceptId && (f.parentId ?? null) === (parentId ?? null) && f.name.toLowerCase() === clean.toLowerCase());
  if (dup) return { ok: false, error: `Hier gibt es schon einen Ordner «${clean}».` };
  return { ok: true, name: clean };
}
