/**
 * Request schemas for caretaker seats. Kept in their own module rather than
 * appended to `schemas.ts` so the feature stays self-contained.
 */
import { z } from 'zod';
import { MAX_CARETAKER_DAYS } from '../services/caretakerService.js';

export const createCaretakerSchema = z
  .object({
    /** The name every action this seat takes is attributed to. Required —
     *  an unnamed caretaker is just a sitter link, which already exists. */
    name: z.string().trim().min(1).max(60),
    startsAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
  })
  .superRefine((val, ctx) => {
    const start = val.startsAt ? Date.parse(val.startsAt) : Date.now();
    const end = Date.parse(val.expiresAt);
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must be in the future (after startsAt)',
      });
    } else if (end - start > MAX_CARETAKER_DAYS * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: `A caretaker seat cannot last longer than ${MAX_CARETAKER_DAYS} days`,
      });
    }
  });
export type CreateCaretakerInput = z.infer<typeof createCaretakerSchema>;

/** Completing a task: `expectedNextDue` identifies the recurrence occurrence
 *  so a retried request cannot complete the next cycle too. */
export const caretakerCompleteTaskSchema = z
  .object({ expectedNextDue: z.string().datetime().optional() })
  .nullish();
export type CaretakerCompleteTaskInput = z.infer<typeof caretakerCompleteTaskSchema>;

export const caretakerNoteSchema = z.object({
  text: z.string().trim().min(1).max(500),
});
export type CaretakerNoteInput = z.infer<typeof caretakerNoteSchema>;

export const caretakerPhotoRequestSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  })
  .nullable();
export type CaretakerPhotoRequestInput = z.infer<typeof caretakerPhotoRequestSchema>;

export const caretakerPhotoConfirmSchema = z.object({
  imageUrl: z.string().url().max(500),
});
export type CaretakerPhotoConfirmInput = z.infer<typeof caretakerPhotoConfirmSchema>;
