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
 * control caching), then a leaf-shaped SVG placeholder. The Perenual URL
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

  return (
    <div className={clsx('w-full h-full flex items-center justify-center', className)}>
      <svg
        className="h-1/2 w-1/2 text-gray-300"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 21c-2-2-5-3-5-8 0-3 2-5 5-5s5 2 5 5c0 5-3 6-5 8z"
        />
      </svg>
    </div>
  );
}
