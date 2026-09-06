/**
 * The handoff brief is a TEMPLATE RENDER over what the household recorded.
 * These tests pin the two things that make it trustworthy: a gap stays a gap
 * (never filled with plausible care text), and every toxicity claim comes
 * from the curated table — with silence, not an all-clear, when the table has
 * no match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The presigner is the one piece that needs real AWS credentials to run, so it
// is the only thing stubbed: `plantImageKeyForHousehold` (the household-scoping
// check that decides whether a photo is signable at all) runs for real.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (
      _client: unknown,
      command: { input: { Bucket: string; Key: string } },
      options: { expiresIn: number }
    ) => `https://signed.example/${command.input.Key}?ttl=${options.expiresIn}`
  ),
}));

vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/spaceService.js', () => ({ getSpaces: vi.fn() }));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasks: vi.fn(),
  sitterWindowCutoff: (end: string, now: Date) =>
    end > now.toISOString() ? end : now.toISOString(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-03T12:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS).toISOString();

const LINK = {
  label: 'The Smiths’ plants',
  householdId: 'hh-1',
  startsAt: inDays(-1),
  expiresAt: inDays(20),
};

function plant(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Monstera',
    species: 'Monstera deliciosa',
    location: null,
    spaceId: 's1',
    placementNote: 'east window, top shelf',
    imageUrl: 'https://cdn.example/plants/hh-1/p1/abc123.jpg',
    notes: 'Bottom-water this one',
    status: 'active',
    ...over,
  };
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    householdId: 'hh-1',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    nextDue: inDays(2),
    notes: 'private task note',
    ...over,
  };
}

async function load(
  plants: unknown[],
  tasks: unknown[],
  spaces: unknown[] = [{ id: 's1', householdId: 'hh-1', name: 'Living Room' }]
) {
  const plantService = await import('../../../src/services/plantService.js');
  const spaceService = await import('../../../src/services/spaceService.js');
  const taskService = await import('../../../src/services/taskService.js');
  vi.mocked(plantService.getPlants).mockResolvedValue(plants as never);
  vi.mocked(spaceService.getSpaces).mockResolvedValue(spaces as never);
  vi.mocked(taskService.getTasks).mockResolvedValue(tasks as never);
  return import('../../../src/services/sitterBrief.js');
}

beforeEach(() => vi.clearAllMocks());

describe('buildSitterBrief', () => {
  it('renders the plant’s own words, place, photo and window tasks', async () => {
    const { buildSitterBrief } = await load([plant()], [task()]);
    const brief = await buildSitterBrief(LINK, NOW);

    expect(brief.label).toBe('The Smiths’ plants');
    expect(brief.plants).toHaveLength(1);
    const [entry] = brief.plants;
    expect(entry).toMatchObject({
      plantId: 'p1',
      name: 'Monstera',
      spaceName: 'Living Room',
      placementNote: 'east window, top shelf',
      careNote: 'Bottom-water this one',
      careNoteSource: 'notes',
      photoUrl: 'https://signed.example/plants/hh-1/p1/abc123.jpg?ttl=3600',
    });
    expect(entry.tasks).toEqual([
      { taskId: 't1', taskType: 'water', dueDate: inDays(2), overdue: false },
    ]);
    // Task-level private notes never reach the sitter.
    expect(JSON.stringify(brief)).not.toContain('private task note');
  });

  it('prefers a structured care rule over free-text notes, and says which it used', async () => {
    const { buildSitterBrief } = await load(
      [plant({ careRule: 'Bottom-water only, never from the top' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.careNote).toBe('Bottom-water only, never from the top');
    expect(entry.careNoteSource).toBe('rule');
  });

  it('leaves an empty note EMPTY — no invented care text, and whitespace is not a note', async () => {
    const { buildSitterBrief } = await load(
      [plant({ notes: '   ', careRule: null, placementNote: '  ' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.careNote).toBeNull();
    expect(entry.careNoteSource).toBeNull();
    expect(entry.placementNote).toBeNull();
  });

  it('takes every toxicity verdict from the curated table and names what it matched', async () => {
    const { buildSitterBrief } = await load([plant()], []);
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.petSafety).toMatchObject({
      slug: 'monstera',
      cats: 'toxic',
      dogs: 'toxic',
      matchedOn: 'Monstera deliciosa',
    });
    expect(entry.petSafety?.note).toMatch(/calcium oxalate/i);
  });

  it('returns null — not "safe" — for a plant the curated table does not know', async () => {
    const { buildSitterBrief } = await load(
      [plant({ id: 'p9', name: 'Doris', species: 'Nothing recognisable here' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.petSafety).toBeNull();
  });

  it('falls back to the display name when there is no species', async () => {
    const { buildSitterBrief } = await load([plant({ species: null, name: 'Pothos' })], []);
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.petSafety).toMatchObject({ slug: 'pothos', matchedOn: 'Pothos' });
  });

  it('includes only tasks due inside the link window, overdue first, marked overdue', async () => {
    const { buildSitterBrief } = await load(
      [plant()],
      [
        task({ id: 'later', nextDue: inDays(40) }),
        task({ id: 'inside', nextDue: inDays(19) }),
        task({ id: 'late', nextDue: inDays(-3) }),
      ]
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.tasks.map((t) => t.taskId)).toEqual(['late', 'inside']);
    expect(entry.tasks[0].overdue).toBe(true);
    expect(entry.tasks[1].overdue).toBe(false);
  });

  it('lists plants with work first (soonest first), then the rest by name', async () => {
    const { buildSitterBrief } = await load(
      [
        plant({ id: 'quiet-b', name: 'Zebra plant', species: null }),
        plant({ id: 'quiet-a', name: 'Aloe', species: null }),
        plant({ id: 'soon', name: 'Fern', species: null }),
        plant({ id: 'later', name: 'Fig', species: null }),
      ],
      [
        task({ id: 't-soon', plantId: 'soon', nextDue: inDays(1) }),
        task({ id: 't-later', plantId: 'later', nextDue: inDays(9) }),
      ]
    );
    const brief = await buildSitterBrief(LINK, NOW);
    expect(brief.plants.map((p) => p.plantId)).toEqual(['soon', 'later', 'quiet-a', 'quiet-b']);
    // A plant with nothing due is still listed, with an empty task list.
    expect(brief.plants[2].tasks).toEqual([]);
  });

  it('shows a plant with no space as having none, rather than guessing one', async () => {
    const { buildSitterBrief } = await load(
      [plant({ spaceId: null, location: null })],
      [],
      [{ id: 's1', householdId: 'hh-1', name: 'Living Room' }]
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.spaceName).toBeNull();
  });
});

/**
 * #453: the brief's photo URLs were permanent, unauthenticated CloudFront URLs
 * on a behavior with no viewer authorization, cached at the edge for a year.
 * Every other sitter capability is re-checked on each call and dies on revoke;
 * the photographs of the inside of someone's home did not. A sitter who saved
 * the page kept them, and so did anyone they forwarded them to.
 */
describe('buildSitterBrief — a photo expires with the brief (#453)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hands out a signed URL, never the permanent public one', async () => {
    const { buildSitterBrief } = await load([plant()], []);
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.photoUrl).toBe('https://signed.example/plants/hh-1/p1/abc123.jpg?ttl=3600');
    expect(entry.photoUrl).not.toContain('cdn.example');
    expect(JSON.stringify(entry)).not.toContain('https://cdn.example/');
  });

  it('caps the signature at an hour even though the link runs for weeks', async () => {
    const presigner = await import('@aws-sdk/s3-request-presigner');
    const { buildSitterBrief } = await load([plant()], []);
    await buildSitterBrief(LINK, NOW); // LINK expires in 20 days
    const [, , options] = vi.mocked(presigner.getSignedUrl).mock.calls[0];
    expect((options as { expiresIn: number }).expiresIn).toBe(3600);
  });

  it('never signs for longer than the link has left', async () => {
    const presigner = await import('@aws-sdk/s3-request-presigner');
    const { buildSitterBrief } = await load([plant()], []);
    const shortLink = { ...LINK, expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() };
    await buildSitterBrief(shortLink, NOW);
    const [, , options] = vi.mocked(presigner.getSignedUrl).mock.calls[0];
    expect((options as { expiresIn: number }).expiresIn).toBe(600);
  });

  it('signs the key from the URL path, so an older asset origin still resolves', async () => {
    const presigner = await import('@aws-sdk/s3-request-presigner');
    const { buildSitterBrief } = await load(
      [plant({ imageUrl: 'https://old-bucket.s3.amazonaws.com/plants/hh-1/p1/abc123.jpg' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.photoUrl).toContain('signed.example');
    const [, command] = vi.mocked(presigner.getSignedUrl).mock.calls[0];
    expect((command as { input: { Key: string } }).input.Key).toBe('plants/hh-1/p1/abc123.jpg');
  });

  it('refuses to sign a key outside the household, and omits the photo', async () => {
    const presigner = await import('@aws-sdk/s3-request-presigner');
    const { buildSitterBrief } = await load(
      [plant({ imageUrl: 'https://cdn.example/plants/some-other-household/p1/abc123.jpg' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    // Fail closed: no signature, and NOT a fallback to the permanent URL.
    expect(entry.photoUrl).toBeNull();
    expect(presigner.getSignedUrl).not.toHaveBeenCalled();
  });

  it('omits — rather than passes through — a URL of an unrecognised shape', async () => {
    const { buildSitterBrief } = await load(
      [plant({ imageUrl: 'https://cdn.example/p1.jpg' })],
      []
    );
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.photoUrl).toBeNull();
  });

  it('leaves a plant with no photo at null, without signing anything', async () => {
    const presigner = await import('@aws-sdk/s3-request-presigner');
    const { buildSitterBrief } = await load([plant({ imageUrl: null })], []);
    const [entry] = (await buildSitterBrief(LINK, NOW)).plants;
    expect(entry.photoUrl).toBeNull();
    expect(presigner.getSignedUrl).not.toHaveBeenCalled();
  });
});
