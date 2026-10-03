import { Dialog } from '@headlessui/react';

export interface ActionSheetRequest {
  title: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  cancel: string;
}

interface ActionSheetProps {
  request: ActionSheetRequest | null;
  /** The chosen option's id, or null for Cancel, Escape or a tap outside. */
  onChoose: (id: string | null) => void;
}

/**
 * A short list of choices that slides up from the bottom, for the website
 * (the iOS app shows Apple's own action sheet instead). Only a tap on an
 * option is a choice: Cancel, Escape and a tap outside all answer null.
 */
export function ActionSheet({ request, onChoose }: ActionSheetProps) {
  return (
    <Dialog open={request !== null} onClose={() => onChoose(null)} className="relative z-50">
      <div className="fixed inset-0 bg-primary-950/50" aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 z-10 p-3 safe-area-y sm:inset-0 sm:flex sm:items-center sm:justify-center">
        <Dialog.Panel className="mx-auto w-full max-w-md space-y-2">
          <div className="overflow-hidden rounded-2xl bg-paper shadow-xl">
            <Dialog.Title className="px-4 py-3 text-center text-sm font-semibold text-gray-600">
              {request?.title}
            </Dialog.Title>
            {request?.options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onChoose(option.id)}
                className="flex min-h-touch w-full items-center justify-center border-t border-primary-100 px-4 py-3 text-base font-medium text-primary-800 hover:bg-parchment focus-visible:bg-parchment focus-visible:outline-hidden"
              >
                {option.title}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onChoose(null)}
            className="flex min-h-touch w-full items-center justify-center rounded-2xl bg-paper px-4 py-3 text-base font-semibold text-ink shadow-xl hover:bg-parchment focus-visible:bg-parchment focus-visible:outline-hidden"
          >
            {request?.cancel}
          </button>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
