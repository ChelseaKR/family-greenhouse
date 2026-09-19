import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_MAX_BYTES,
  archiveUpload,
  readArchiveFile,
  uploadBytes,
} from '@/features/settings/archiveFile';

/**
 * The browser-side read of a household archive (#669). The server re-checks
 * all of it; what this pins is the early answer for a wrong file and that the
 * upload carries ONE household and none of the person's profile.
 */
function exportDoc(extra: Record<string, unknown> = {}) {
  return {
    format: 'family-greenhouse-export',
    version: 1,
    exportedAt: '2026-09-01T00:00:00.000Z',
    user: { id: 'u1', email: 'someone@example.invalid', name: 'Someone' },
    notificationPreferences: { email: true },
    households: [
      { id: 'h1', name: 'Home', plants: [{ id: 'p1' }, { id: 'p2' }], tasks: [{ id: 't1' }] },
      { id: 'h2', name: 'Cabin', plants: [], tasks: [] },
    ],
    ...extra,
  };
}

const read = (doc: unknown) => {
  const text = JSON.stringify(doc);
  return readArchiveFile(text, text.length);
};

describe('readArchiveFile', () => {
  it('lists the households an export holds, with their counts', () => {
    const result = read(exportDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.households).toEqual([
      { id: 'h1', name: 'Home', plants: 2, tasks: 1 },
      { id: 'h2', name: 'Cabin', plants: 0, tasks: 0 },
    ]);
    expect(result.file.exportedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('reads every version up to the newest, so a file the released app wrote still restores', () => {
    expect(read(exportDoc({ version: 1 }))).toMatchObject({ ok: true, file: { version: 1 } });
    expect(read(exportDoc({ version: 2 }))).toMatchObject({ ok: true, file: { version: 2 } });
  });

  it('names a newer version, and refuses other files before any upload', () => {
    expect(read(exportDoc({ version: 3 }))).toEqual({
      ok: false,
      error: 'newerVersion',
      version: 3,
    });
    expect(read(exportDoc({ version: 0 }))).toMatchObject({
      ok: false,
      error: 'unsupportedVersion',
    });
    expect(read(exportDoc({ version: '1' }))).toMatchObject({
      ok: false,
      error: 'unsupportedVersion',
    });
    expect(read(exportDoc({ format: 'planta' }))).toMatchObject({
      ok: false,
      error: 'notAnArchive',
    });
    expect(read([exportDoc()])).toMatchObject({ ok: false, error: 'notAnArchive' });
    expect(read(exportDoc({ households: [] }))).toMatchObject({ ok: false, error: 'noHouseholds' });
    expect(readArchiveFile('{not json', 9)).toEqual({ ok: false, error: 'notJson' });
    expect(readArchiveFile('{}', ARCHIVE_MAX_BYTES + 1)).toEqual({ ok: false, error: 'tooLarge' });
  });
});

describe('archiveUpload', () => {
  it('sends the chosen household only — never the profile, preferences or other homes', () => {
    const result = read(exportDoc());
    if (!result.ok) throw new Error('expected a readable archive');
    const upload = archiveUpload(result.file, 'h2');
    expect(upload).toEqual({
      format: 'family-greenhouse-export',
      version: 1,
      exportedAt: '2026-09-01T00:00:00.000Z',
      households: [{ id: 'h2', name: 'Cabin', plants: [], tasks: [] }],
    });
    // Negative control: the file itself does carry the profile.
    expect(JSON.stringify(result.file.document)).toContain('someone@example.invalid');
    expect(JSON.stringify(upload)).not.toContain('someone@example.invalid');
    expect(uploadBytes(upload)).toBe(new TextEncoder().encode(JSON.stringify(upload)).length);
  });
});
