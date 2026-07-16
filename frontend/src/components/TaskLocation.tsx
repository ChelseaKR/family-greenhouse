import { MapPinIcon } from '@heroicons/react/24/outline';

export function TaskLocation({ label }: { label: string }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-gray-600">
      <MapPinIcon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </p>
  );
}
