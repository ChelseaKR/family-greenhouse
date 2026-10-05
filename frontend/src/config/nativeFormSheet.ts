import type { TFunction } from 'i18next';

/**
 * A web form drawn as a native sheet in the iOS app (NativeChrome
 * `presentForm`, ios/App/App/NativeFormSheet.swift). The web owns the words,
 * the choices and the starting values; Swift draws them and answers once:
 * the shown fields' values on the sheet's own submit button, or null for any
 * other ending (Cancel, a swipe down, the web closing it, another one
 * replacing it). NativeFormSheetModel.swift keeps that rule on the Swift side
 * and `formSheetValues` below keeps it on this one: a dismissal can never
 * submit.
 */
export type NativeFormSheetField =
  | {
      kind: 'choice';
      id: string;
      label: string;
      options: Array<{ id: string; title: string }>;
      value: string;
    }
  | {
      kind: 'stepper';
      id: string;
      label: string;
      value: number;
      min: number;
      max: number;
      /** The words for 1, and for any other number with `{n}` in them. */
      one: string;
      other: string;
    }
  | {
      kind: 'text';
      id: string;
      label: string;
      value: string;
      placeholder?: string;
      multiline?: boolean;
      required?: boolean;
      maxLength?: number;
      /** Shown only while another field holds this value. */
      visibleWhen?: { field: string; equals: string };
    };

export interface NativeFormSheetRequest {
  token: string;
  title: string;
  /** Above the fields: why the last submit came back. */
  message?: string;
  cancel: string;
  submit: string;
  fields: NativeFormSheetField[];
}

export interface NativeFormSheetResult {
  values: Record<string, unknown> | null;
}

export const ADD_TASK_TYPES = ['water', 'fertilize', 'prune', 'repot', 'custom'] as const;

export interface AddTaskValues {
  type: (typeof ADD_TASK_TYPES)[number];
  customType: string;
  frequency: number;
  notes: string;
}

/** Add care task, as a form sheet, in the app's language. */
export function addTaskFormRequest(
  t: TFunction,
  values: AddTaskValues,
  message?: string
): Omit<NativeFormSheetRequest, 'token'> {
  return {
    title: t('tasks.formSheet.addTitle'),
    ...(message ? { message } : {}),
    cancel: t('common.cancel'),
    submit: t('tasks.formSheet.add'),
    fields: [
      {
        kind: 'choice',
        id: 'type',
        label: t('tasks.formSheet.type'),
        options: ADD_TASK_TYPES.map((type) => ({ id: type, title: t(`tasks.types.${type}`) })),
        value: values.type,
      },
      {
        kind: 'text',
        id: 'customType',
        label: t('tasks.formSheet.customName'),
        value: values.customType,
        required: true,
        maxLength: 50,
        visibleWhen: { field: 'type', equals: 'custom' },
      },
      {
        kind: 'stepper',
        id: 'frequency',
        label: t('tasks.formSheet.howOften'),
        value: values.frequency,
        min: 1,
        max: 365,
        one: t('tasks.formSheet.everyDay'),
        other: t('tasks.formSheet.everyNDays'),
      },
      {
        kind: 'text',
        id: 'notes',
        label: t('tasks.formSheet.notes'),
        value: values.notes,
        multiline: true,
        maxLength: 500,
      },
    ],
  };
}

/**
 * What the sheet answered, as Add care task values, or null when it was not
 * a submit or the values are not the kind this form sends. Anything that is
 * not exactly a submit closes the form without writing.
 */
export function formSheetValues(
  result: NativeFormSheetResult | null | undefined
): AddTaskValues | null {
  const values = result?.values;
  if (!values || typeof values !== 'object') return null;
  const type = values.type;
  const frequency = values.frequency;
  if (typeof type !== 'string' || !(ADD_TASK_TYPES as readonly string[]).includes(type))
    return null;
  if (typeof frequency !== 'number' || !Number.isInteger(frequency)) return null;
  if (frequency < 1 || frequency > 365) return null;
  const customType = typeof values.customType === 'string' ? values.customType.trim() : '';
  if (type === 'custom' && !customType) return null;
  return {
    type: type as AddTaskValues['type'],
    customType,
    frequency,
    notes: typeof values.notes === 'string' ? values.notes : '',
  };
}
