import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CareReportCard } from '@/features/plants/CareReportCard';
import { RECENT_COMPLETIONS_LIMIT } from '@/services/plantService';
import type { PlantWithTasks, Task, TaskCompletion } from '@/services/plantService';

/**
 * `GET /plants/{id}` returns at most RECENT_COMPLETIONS_LIMIT completions in
 * `recentCompletions`. Every figure on this card is derived from that list,
 * so every figure has a ceiling that has nothing to do with how the plant was
 * actually cared for. The card used to print that ceiling as "Total
 * completions" and "Longest streak". These tests hold the labels to the
 * window they actually describe.
 */

const task: Task = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water',
  customType: undefined,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-05-01',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u',
  createdAt: '',
};

function completion(daysAgo: number): TaskCompletion {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    id: `c-${daysAgo}`,
    taskId: 't1',
    taskType: 'water',
    completedBy: 'u',
    completedByName: 'A',
    completedAt: d.toISOString(),
    notes: null,
  };
}

function plantWith(completions: TaskCompletion[]): PlantWithTasks {
  return {
    id: 'p1',
    householdId: 'h1',
    name: 'Pothos',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    createdAt: '',
    createdBy: 'u',
    updatedAt: '',
    upcomingTasks: [task],
    recentCompletions: completions,
  };
}

describe('CareReportCard', () => {
  it('labels the completion count with the window it can actually see', () => {
    render(<CareReportCard plant={plantWith([completion(0), completion(7)])} />);

    expect(screen.getByText(`Completions (last ${RECENT_COMPLETIONS_LIMIT})`)).toBeInTheDocument();
    // The old label claimed a lifetime total the endpoint never returns.
    expect(screen.queryByText('Total completions')).not.toBeInTheDocument();
  });

  it('labels the streak with the same window rather than calling it the longest ever', () => {
    render(<CareReportCard plant={plantWith([completion(0), completion(7), completion(14)])} />);

    expect(screen.getByText(`Best streak (last ${RECENT_COMPLETIONS_LIMIT})`)).toBeInTheDocument();
    expect(screen.queryByText('Longest streak')).not.toBeInTheDocument();
  });

  it('says in the card description that older care is not counted', () => {
    render(<CareReportCard plant={plantWith([completion(0)])} />);

    expect(
      screen.getByText(new RegExp(`last ${RECENT_COMPLETIONS_LIMIT} logged completions`, 'i'))
    ).toBeInTheDocument();
  });

  it('cannot report more completions than the endpoint returns', () => {
    // A plant cared for far more often than the window: the API still hands
    // the card RECENT_COMPLETIONS_LIMIT rows, so the count saturates there.
    const capped = Array.from({ length: RECENT_COMPLETIONS_LIMIT }, (_, i) => completion(i * 7));
    render(<CareReportCard plant={plantWith(capped)} />);

    expect(screen.getByText(String(RECENT_COMPLETIONS_LIMIT))).toBeInTheDocument();
  });
});
