/**
 * Photo upload, identification, and the public share preview.
 *
 * `uploadImage` is deliberately XHR-based (fetch has no upload-progress
 * events), so its abort/error/non-2xx paths have no framework covering them —
 * an abandoned upload must reject rather than run on and confirm server-side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

const API = 'http://localhost:4000';

type Behavior = (xhr: FakeXhr) => void;
let behavior: Behavior = (xhr) => xhr.finish(200);

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: Blob | null = null;
  aborted = false;
  upload: {
    onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(blob: Blob) {
    this.sent = blob;
    queueMicrotask(() => behavior(this));
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  finish(status: number) {
    this.status = status;
    this.onload?.();
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total });
  }
}

function blob() {
  return new Blob(['bytes'], { type: 'image/webp' });
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeXhr.instances = [];
  behavior = (xhr) => xhr.finish(200);
  useAuthStore.setState({ accessToken: 'access-1' });
});

describe('plantService.getImageUploadUrl', () => {
  it('presigns against the content type the PUT will send', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/plants/p1/image`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ uploadUrl: 'https://s3.test/put', imageUrl: 'https://cdn/x' });
      })
    );

    await expect(plantService.getImageUploadUrl('p1', 'image/webp')).resolves.toMatchObject({
      uploadUrl: 'https://s3.test/put',
    });
    expect(body).toEqual({ contentType: 'image/webp' });
  });
});

describe('plantService.uploadImage', () => {
  // Scoped to this block: axios uses the XHR adapter in jsdom, so a global
  // stub would hang every other request in this file.
  beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
  afterEach(() => vi.unstubAllGlobals());

  it('PUTs the blob with the presigned content type and reports progress', async () => {
    const onProgress = vi.fn();
    behavior = (xhr) => {
      xhr.progress(50, 200);
      xhr.progress(200, 200);
      xhr.finish(204);
    };

    await plantService.uploadImage('https://s3.test/put', blob(), 'image/webp', onProgress);

    const xhr = FakeXhr.instances[0];
    expect([xhr.method, xhr.url]).toEqual(['PUT', 'https://s3.test/put']);
    expect(xhr.headers['Content-Type']).toBe('image/webp');
    expect(xhr.sent).toBeInstanceOf(Blob);
    expect(onProgress.mock.calls).toEqual([[0.25], [1]]);
  });

  it('ignores progress events with no computable length', async () => {
    const onProgress = vi.fn();
    behavior = (xhr) => {
      xhr.progress(10, 0, false);
      xhr.finish(200);
    };

    await plantService.uploadImage('https://s3.test/put', blob(), 'image/webp', onProgress);

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('tolerates a caller that passes no progress callback', async () => {
    behavior = (xhr) => {
      xhr.progress(1, 2);
      xhr.finish(200);
    };

    await expect(
      plantService.uploadImage('https://s3.test/put', blob(), 'image/webp')
    ).resolves.toBeUndefined();
  });

  it('rejects on a non-2xx S3 response', async () => {
    behavior = (xhr) => xhr.finish(403);

    await expect(
      plantService.uploadImage('https://s3.test/put', blob(), 'image/webp')
    ).rejects.toThrow('Upload failed with status 403');
  });

  it('rejects when the transport itself fails', async () => {
    behavior = (xhr) => xhr.onerror?.();

    await expect(
      plantService.uploadImage('https://s3.test/put', blob(), 'image/webp')
    ).rejects.toThrow('Network error during upload');
  });

  it('aborts the in-flight PUT when the caller cancels mid-upload', async () => {
    const controller = new AbortController();
    behavior = (xhr) => {
      xhr.progress(10, 100);
      controller.abort();
    };

    const promise = plantService.uploadImage(
      'https://s3.test/put',
      blob(),
      'image/webp',
      undefined,
      controller.signal
    );

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances[0].aborted).toBe(true);
  });

  it('never opens a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      plantService.uploadImage(
        'https://s3.test/put',
        blob(),
        'image/webp',
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe('plantService reads and shares', () => {
  it('getPlantHistory returns the completion log', async () => {
    server.use(
      http.get(`${API}/plants/p1/history`, () =>
        HttpResponse.json([
          {
            id: 'c1',
            taskId: 't1',
            taskType: 'water',
            completedBy: 'u1',
            completedByName: 'Chelsea',
            completedAt: '2026-08-01',
            notes: null,
          },
        ])
      )
    );

    await expect(plantService.getPlantHistory('p1')).resolves.toHaveLength(1);
  });

  it('identifyPlant reports an unconfigured provider instead of inventing matches', async () => {
    server.use(http.post(`${API}/plants/identify`, () => HttpResponse.json({ configured: false })));

    const result = await plantService.identifyPlant('data:image/webp;base64,AAA');

    expect(result.configured).toBe(false);
    expect(result.suggestions).toBeUndefined();
  });

  it('getSharedPlant reads the public preview without household data', async () => {
    server.use(
      http.get(`${API}/plants/shared/abc123`, () =>
        HttpResponse.json({
          plant: {
            name: 'Pothos cutting',
            species: 'Epipremnum aureum',
            notes: null,
            imageUrl: null,
            tags: ['cutting'],
          },
          householdName: 'Greenhouse',
          expiresAt: '2026-08-20',
        })
      )
    );

    const preview = await plantService.getSharedPlant('abc123');

    expect(preview.plant.name).toBe('Pothos cutting');
    expect(preview).not.toHaveProperty('householdId');
  });
});
