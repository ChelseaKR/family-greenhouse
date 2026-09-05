/**
 * One live region per announcement.
 *
 * #446 made `Alert`'s politeness a function of its variant, which was right:
 * ~140 mostly-informational uses had been unconditionally `role="alert"`. But
 * making a shared component announce differently re-classifies every call
 * site, and four of them render an Alert INSIDE a live region the surrounding
 * page already declares. That is not a variant question and the variant fix
 * could not have addressed it:
 *
 *   - a polite Alert inside a polite parent is two regions seeing one change,
 *     which screen readers announce twice;
 *   - an assertive Alert inside a polite parent defeats the parent outright,
 *     which is the case `Alert`'s own documentation warns about.
 *
 * `PetSafePage` is the reference — every Alert inside its polite wrapper
 * passes `live="off"` — and these four had the same shape and not the same
 * fix. Nesting is a structural property, so it is asserted structurally here
 * rather than re-litigated per component: axe has no rule for it (both are
 * valid ARIA), and neither does any other gate in the repo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { CaretakerPage } from '@/features/caretaker/CaretakerPage';
import { SitPage } from '@/features/sitter/SitPage';
import { ScanTagPage } from '@/features/tags/ScanTagPage';
import { SitterPhotoBack } from '@/features/sitter/SitterPhotoBack';
import { PetSafePage } from '@/features/petsafe/PetSafePage';

import {
  caretakerVisitService,
  type CaretakerTask,
  type CaretakerView,
} from '@/services/caretakerVisitService';
import { sitterService, type SitterTask, type SitterView } from '@/services/sitterService';
import { publicTagService, type TagView } from '@/services/plantTagService';
import { sitterPhotoService } from '@/services/sitterPhotoService';

vi.mock('@/services/caretakerVisitService', async () => {
  const actual = await vi.importActual<typeof import('@/services/caretakerVisitService')>(
    '@/services/caretakerVisitService'
  );
  return {
    ...actual,
    caretakerVisitService: {
      getView: vi.fn(),
      completeTask: vi.fn(),
      addNote: vi.fn(),
      addPhoto: vi.fn(),
    },
  };
});
vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return { ...actual, sitterService: { getView: vi.fn(), completeTask: vi.fn() } };
});
vi.mock('@/services/plantTagService', async () => {
  const actual = await vi.importActual<typeof import('@/services/plantTagService')>(
    '@/services/plantTagService'
  );
  return { ...actual, publicTagService: { getView: vi.fn(), completeTask: vi.fn() } };
});
vi.mock('@/services/sitterPhotoService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterPhotoService')>(
    '@/services/sitterPhotoService'
  );
  return { ...actual, sitterPhotoService: { getStatus: vi.fn(), upload: vi.fn() } };
});
vi.mock('@/utils/image', () => ({
  downscaleImage: vi.fn(async () => new Blob(['tiny'], { type: 'image/webp' })),
}));

/**
 * An element that announces its own content changes: an explicit `aria-live`
 * other than `off`, or a role that implies one. `role="alert"` implies
 * assertive and `role="status"`/`role="log"` imply polite, so a nested one is
 * a nested live region even with no `aria-live` attribute in the markup.
 */
const LIVE_REGION_SELECTOR = '[aria-live]:not([aria-live="off"]),[role="alert"],[role="status"]';

function describeRegion(element: Element): string {
  const role = element.getAttribute('role');
  const live = element.getAttribute('aria-live');
  const label = (element.textContent ?? '').trim().slice(0, 60);
  return `<${element.tagName.toLowerCase()}${role ? ` role="${role}"` : ''}${
    live ? ` aria-live="${live}"` : ''
  }> "${label}"`;
}

/** Fails when any live region has a live-region ancestor. */
function expectNoNestedLiveRegions(container: HTMLElement): void {
  const nested = [...container.querySelectorAll(LIVE_REGION_SELECTOR)]
    .filter((element) => element.parentElement?.closest(LIVE_REGION_SELECTOR))
    .map(
      (element) =>
        `${describeRegion(element)} nested inside ` +
        `${describeRegion(element.parentElement!.closest(LIVE_REGION_SELECTOR)!)}`
    );
  expect(nested).toEqual([]);
}

const TOKEN = 'a'.repeat(64);

function renderAt(path: string, pattern: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('no live region is nested inside another live region', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // SitPage renders SitterPhotoBack, which reads its own status on mount.
    vi.mocked(sitterPhotoService.getStatus).mockResolvedValue({
      enabled: false,
      max: 60,
      used: null,
      remaining: null,
    });
  });

  it('CaretakerPage: the empty-list Alert inside the completions region', async () => {
    // remaining.length === 0 is the branch that swaps the task list for an
    // Alert, inside the wrapper that announces completions. An empty list on
    // arrival renders the nothing-due Alert rather than the thank-you one
    // (#604); both sit in the same wrapper, so either exercises the nesting.
    vi.mocked(caretakerVisitService.getView).mockResolvedValue({
      caretakerName: 'Dana',
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      permissions: ['task.complete'],
      tasks: [] as CaretakerTask[],
    } as CaretakerView);

    const { container } = renderAt(`/caretaker/${TOKEN}`, '/caretaker/:token', <CaretakerPage />);
    await screen.findByText('Nothing due right now');
    expectNoNestedLiveRegions(container);
  });

  it('SitPage: the empty-list Alert inside the completions region', async () => {
    vi.mocked(sitterService.getView).mockResolvedValue({
      label: 'The Smiths’ plants',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      tasks: [] as SitterTask[],
    } as SitterView);

    const { container } = renderAt(`/sit/${TOKEN}`, '/sit/:token', <SitPage />);
    await screen.findByText('Nothing to do right now');
    expectNoNestedLiveRegions(container);
  });

  it('ScanTagPage: the thanks Alert inside the due-task region', async () => {
    const due = {
      taskId: 't1',
      taskType: 'water',
      dueDate: new Date(Date.now() - 3_600_000).toISOString(),
      overdue: true,
    };
    vi.mocked(publicTagService.getView).mockResolvedValue({
      plantName: 'Monstera',
      species: null,
      imageUrl: null,
      careNotes: null,
      history: { status: 'ok', lastCare: null, lastWatered: null },
      tasks: [due],
    } as TagView);
    vi.mocked(publicTagService.completeTask).mockResolvedValue({
      taskId: 't1',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      completedByName: 'Grandma',
      alreadyDone: false,
    });

    const { container } = renderAt(`/tag/${'a3f9'.repeat(16)}`, '/tag/:token', <ScanTagPage />);
    await userEvent.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
    await userEvent.click(screen.getByRole('button', { name: 'I just did this' }));

    await screen.findByText('Thank you, Grandma!');
    expectNoNestedLiveRegions(container);
  });

  it('ScanTagPage: the failed-completion Alert inside the due-task region', async () => {
    // The sharper half: this Alert is variant="error", so before the fix it
    // was an ASSERTIVE region inside a polite one.
    vi.mocked(publicTagService.getView).mockResolvedValue({
      plantName: 'Monstera',
      species: null,
      imageUrl: null,
      careNotes: null,
      history: { status: 'ok', lastCare: null, lastWatered: null },
      tasks: [
        {
          taskId: 't1',
          taskType: 'water',
          dueDate: new Date(Date.now() - 3_600_000).toISOString(),
          overdue: true,
        },
      ],
    } as TagView);
    vi.mocked(publicTagService.completeTask).mockRejectedValue(new Error('network'));

    const { container } = renderAt(`/tag/${'a3f9'.repeat(16)}`, '/tag/:token', <ScanTagPage />);
    await userEvent.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
    await userEvent.click(screen.getByRole('button', { name: 'I just did this' }));

    await screen.findByText('We couldn’t record that');
    expectNoNestedLiveRegions(container);
  });

  it('SitterPhotoBack: the send confirmation, which keeps its own region', async () => {
    vi.mocked(sitterPhotoService.getStatus).mockResolvedValue({
      enabled: true,
      max: 60,
      used: 2,
      remaining: 58,
    });
    vi.mocked(sitterPhotoService.upload).mockResolvedValue({
      photoId: 'ph1',
      plantName: 'Monstera',
      caption: null,
      uploadedAt: new Date().toISOString(),
      used: 3,
      remaining: 57,
    });

    const { container } = render(
      <SitterPhotoBack
        token={TOKEN}
        tasks={[
          {
            taskId: 't1',
            plantName: 'Monstera',
            taskType: 'water',
            dueDate: new Date().toISOString(),
            spaceName: null,
            placementNote: null,
            overdue: false,
          },
        ]}
        onLinkInactive={vi.fn()}
      />
    );
    await screen.findByText('Send a photo home');
    await userEvent.selectOptions(screen.getByLabelText('Which plant is it?'), 't1');
    await userEvent.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['bytes'], 'leaf.jpg', { type: 'image/jpeg' })
    );
    await screen.findByAltText('The photo you picked');
    await userEvent.click(screen.getByRole('button', { name: 'Send photo' }));

    const confirmation = await screen.findByText('Sent 1 photo. Thank you!');
    expectNoNestedLiveRegions(container);

    // Here the wrapper was removed rather than the Alert silenced, because it
    // held nothing but Alerts. The confirmation must still announce itself.
    expect(confirmation.closest('[role="status"]')).not.toBeNull();
  });

  it('PetSafePage stays correct — it is the pattern the others were fixed to', async () => {
    const { container } = renderAt('/pet-safe', '/pet-safe', <PetSafePage />);
    await screen.findByRole('heading', { level: 1 });
    expectNoNestedLiveRegions(container);
  });
});
