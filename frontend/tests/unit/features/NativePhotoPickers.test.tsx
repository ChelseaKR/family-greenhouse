import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeafHealthCard } from '@/features/plants/LeafHealthCard';
import { SitterPhotoBack } from '@/features/sitter/SitterPhotoBack';
import { CaretakerPage } from '@/features/caretaker/CaretakerPage';
import { caretakerVisitService } from '@/services/caretakerVisitService';
import { sitterPhotoService } from '@/services/sitterPhotoService';
import { NativePhotoError } from '@/services/nativeCamera';
import en from '@/i18n/locales/en/translation.json';

const CAMERA_DENIED = en.plants.photoPicker.cameraDenied;

/**
 * pr7c: in the apps, the last three photo inputs open the camera or the
 * library natively, as the plant photo already did. Leaf health and the
 * sitter page show Take photo and Choose photo; the caretaker page's
 * per-task "Add photo" asks which in Apple's sheet. On the website (and in
 * an app without Apple's sheets) the file inputs are unchanged.
 */
const camera = vi.hoisted(() => ({ native: true, pick: vi.fn() }));
vi.mock('@/services/nativeCamera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeCamera')>()),
  canUseNativeCamera: () => camera.native,
  pickNativePhoto: camera.pick,
}));
const sheet = vi.hoisted(() => ({ present: true, choose: vi.fn() }));
vi.mock('@/services/nativePresent', () => ({ chooseFromMenu: sheet.choose }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  hasNativePresent: () => sheet.present,
}));
vi.mock('@/utils/image', () => ({
  // No canvas in jsdom: hand back a tiny image.
  prepareImageForUpload: vi.fn(async () => new Blob(['tiny'], { type: 'image/jpeg' })),
  downscaleImage: vi.fn(async () => new Blob(['tiny'], { type: 'image/webp' })),
}));
vi.mock('@/services/sitterPhotoService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sitterPhotoService')>()),
  sitterPhotoService: { getStatus: vi.fn(), upload: vi.fn() },
}));
vi.mock('@/services/caretakerVisitService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/caretakerVisitService')>()),
  caretakerVisitService: {
    getView: vi.fn(),
    completeTask: vi.fn(),
    addNote: vi.fn(),
    addPhoto: vi.fn(),
  },
}));

const photo = () => new File(['bytes'], 'leaf.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.clearAllMocks();
  camera.native = true;
  sheet.present = true;
});

describe('Leaf health', () => {
  const renderCard = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LeafHealthCard plantId="p1" isOpen onClose={() => {}} />
      </QueryClientProvider>
    );

  it('in the app: Take photo opens the camera and shows the photo to check', async () => {
    camera.pick.mockResolvedValue(photo());
    renderCard();
    expect(screen.queryByRole('button', { name: /choose a photo|pick/i })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Take photo' }));
    expect(camera.pick).toHaveBeenCalledWith('camera');
    expect(await screen.findByRole('img')).toBeInTheDocument();
  });

  it('a cancelled camera changes nothing; a refused one says why', async () => {
    camera.pick.mockResolvedValueOnce(null);
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Choose photo' }));
    expect(camera.pick).toHaveBeenCalledWith('library');
    expect(screen.queryByRole('img')).toBeNull();

    // Camera access refused in Settings: the reason, in words.
    camera.pick.mockRejectedValueOnce(new NativePhotoError('permission', 'camera'));
    await userEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    expect(await screen.findByText(CAMERA_DENIED)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('on the website: the file input, no native buttons', async () => {
    camera.native = false;
    renderCard();
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe('the sitter page', () => {
  const TOKEN = 'a'.repeat(64);
  const tasks = [
    {
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      spaceName: null,
      placementNote: null,
      overdue: false,
    },
  ];
  beforeEach(() => {
    vi.mocked(sitterPhotoService.getStatus).mockResolvedValue({
      enabled: true,
      max: 60,
      used: 2,
      remaining: 58,
    });
  });

  it('in the app: Choose photo opens the library, and the photo goes home', async () => {
    camera.pick.mockResolvedValue(photo());
    vi.mocked(sitterPhotoService.upload).mockResolvedValue({
      photoId: 'ph1',
      plantName: 'Monstera',
      caption: null,
      uploadedAt: new Date().toISOString(),
      used: 3,
      remaining: 57,
    });
    render(<SitterPhotoBack token={TOKEN} tasks={tasks} onLinkInactive={vi.fn()} />);
    await screen.findByText('Send a photo home');
    await userEvent.selectOptions(screen.getByLabelText('Which plant is it?'), 't1');
    await userEvent.click(screen.getByRole('button', { name: 'Choose photo' }));
    expect(camera.pick).toHaveBeenCalledWith('library');
    await screen.findByAltText('The photo you picked');
    await userEvent.click(screen.getByRole('button', { name: 'Send photo' }));
    await waitFor(() =>
      expect(sitterPhotoService.upload).toHaveBeenCalledWith(TOKEN, {
        taskId: 't1',
        image: expect.stringContaining('data:'),
        caption: undefined,
      })
    );
  });
});

describe('the caretaker page', () => {
  const view = {
    caretakerName: 'Dana',
    startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    permissions: ['task.complete', 'photo.add', 'note.add'],
    tasks: [
      {
        taskId: 't1',
        plantId: 'p1',
        plantName: 'Monstera',
        taskType: 'water',
        dueDate: new Date(Date.now() - 1000).toISOString(),
        spaceName: 'Living Room',
        placementNote: null,
        overdue: true,
      },
    ],
  };
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={[`/caretaker/${'a'.repeat(64)}`]}>
        <Routes>
          <Route path="/caretaker/:token" element={<CaretakerPage />} />
        </Routes>
      </MemoryRouter>
    );
  beforeEach(() => {
    vi.mocked(caretakerVisitService.getView).mockResolvedValue(view as never);
    vi.mocked(caretakerVisitService.addPhoto).mockResolvedValue({ visitRecorded: true } as never);
  });

  it('in the app: Add photo asks camera or library, then sends that photo for that plant', async () => {
    sheet.choose.mockResolvedValue('camera');
    const file = photo();
    camera.pick.mockResolvedValue(file);
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a photo of the monstera/i })
    );
    expect(sheet.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { id: 'camera', title: 'Take photo' },
          { id: 'library', title: 'Choose photo' },
        ],
      })
    );
    expect(camera.pick).toHaveBeenCalledWith('camera');
    await waitFor(() =>
      expect(caretakerVisitService.addPhoto).toHaveBeenCalledWith('a'.repeat(64), 'p1', file)
    );
  });

  it('Cancel on the sheet sends nothing and opens nothing', async () => {
    sheet.choose.mockResolvedValue(null);
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a photo of the monstera/i })
    );
    await waitFor(() => expect(sheet.choose).toHaveBeenCalled());
    expect(camera.pick).not.toHaveBeenCalled();
    expect(caretakerVisitService.addPhoto).not.toHaveBeenCalled();
  });

  it('an app without Apple’s sheets keeps the file picker', async () => {
    sheet.present = false;
    renderPage();
    const button = await screen.findByRole('button', { name: /add a photo of the monstera/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(button);
    expect(click).toHaveBeenCalled();
    expect(sheet.choose).not.toHaveBeenCalled();
  });
});
