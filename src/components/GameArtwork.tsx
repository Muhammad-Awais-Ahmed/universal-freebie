"use client";

import { useState } from "react";
import GameIcon from "@/components/GameIcon";

interface GameArtworkProps {
  title: string;
  imageUrl?: string;
  icon?: string;
  imageClassName: string;
  fallbackClassName: string;
  iconClassName?: string;
}

export default function GameArtwork({
  title,
  imageUrl,
  icon,
  imageClassName,
  fallbackClassName,
  iconClassName,
}: GameArtworkProps) {
  const [imageFailed, setImageFailed] = useState(false);

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt={`${title} artwork`}
        className={imageClassName}
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div className={fallbackClassName} data-game-icon={icon} aria-hidden="true">
      <GameIcon name={icon} className={iconClassName} />
    </div>
  );
}
