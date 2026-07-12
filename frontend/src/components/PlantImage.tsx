import { useState } from 'react';
import clsx from 'clsx';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

interface PlantImageProps {
  plant: {
    name: string;
    imageUrl: string | null;
    perenualSpeciesId?: number | null;
  };
  /** Tailwind size classes; defaults to filling the parent. */
  className?: string;
  width?: number;
  height?: number;
}

/**
 * Renders the best available image for a plant: user-uploaded photo first,
 * then the Perenual species thumbnail (proxied through our backend so we
 * control caching), then the shared greenhouse specimen placeholder. The Perenual URL
 * resolves via 302 redirect — the browser follows transparently.
 */
export function PlantImage({ plant, className, width, height }: PlantImageProps) {
  const [thumbFailed, setThumbFailed] = useState(false);

  if (plant.imageUrl) {
    return (
      <img
        src={plant.imageUrl}
        alt={`Photo of ${plant.name}`}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        className={clsx('w-full h-full object-cover', className)}
      />
    );
  }

  if (plant.perenualSpeciesId && !thumbFailed) {
    return (
      <img
        src={`${API_URL}/species/${plant.perenualSpeciesId}/thumbnail`}
        alt={`Stock photo for ${plant.name}`}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        className={clsx('w-full h-full object-cover', className)}
        onError={() => setThumbFailed(true)}
      />
    );
  }

  return <PlantPlaceholder className={className} />;
}

/**
 * Branded fallback used anywhere a plant has no photo. Strong enough to read
 * as intentional artwork at card size, simple enough to remain clear at 48px.
 */
export function PlantPlaceholder({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'relative isolate flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br from-glass via-paper to-parchment',
        className
      )}
      aria-hidden="true"
    >
      <svg className="absolute inset-0 h-full w-full text-primary-700/10" viewBox="0 0 100 100">
        <path
          d="M -15 35 L 20 0 L 55 35 L 90 0 L 125 35"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <path
          d="M 20 0 V 100 M 55 35 V 100 M 90 0 V 100"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.8"
        />
      </svg>
      <svg className="relative h-[58%] w-[58%] drop-shadow-sm" viewBox="0 0 96 96">
        <path d="M48 77V31" fill="none" stroke="#27500A" strokeWidth="4" strokeLinecap="round" />
        <path
          d="M48 52C29 51 20 39 22 23c18 0 28 10 26 29Z"
          fill="#639922"
          stroke="#27500A"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M48 62c19-1 29-13 28-29-18 0-29 10-28 29Z"
          fill="#97C459"
          stroke="#27500A"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M30 75h36l-4 15H34Z"
          fill="#DC6C1F"
          stroke="#A23F1A"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d="M28 75h40" stroke="#A23F1A" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </div>
  );
}
