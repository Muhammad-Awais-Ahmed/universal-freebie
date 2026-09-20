"use client";

import styles from "./GameCard.module.css";
import { formatBytes, formatYearDisplay, getSizeTooltip } from "@/utils/formatters";

interface Game {
  id: string;
  title: string;
  source: string;
  description?: string;
  size?: string | number;
  year?: string | number;
  thumbnail?: string;
  url?: string;
}

export default function GameCard({
  game,
  onDownload,
}: {
  game: Game;
  onDownload: (game: Game) => void;
}) {
  const formattedSize = formatBytes(game.size);
  const sizeTooltip = getSizeTooltip(game.size);
  const formattedYear = formatYearDisplay(game.year);

  return (
    <div className={styles.card}>
      <div className={styles.imageContainer}>
        <img
          src={game.thumbnail}
          alt={game.title}
          className={styles.image}
          onError={(e) => {
            (e.target as HTMLImageElement).src =
              "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%231e293b' width='100' height='100'/><text x='50' y='55' text-anchor='middle' fill='%2364748b' font-size='32'>🎮</text></svg>";
          }}
        />
        <div className={styles.sourceBadge}>{game.source}</div>
      </div>
      <div className={styles.content}>
        <h3 className={styles.title} title={game.title}>
          {game.title}
        </h3>
        <div className={styles.meta}>
          {game.size && (
            <span className={styles.tag} title={sizeTooltip}>
              Size: {formattedSize}
            </span>
          )}
          {game.year && (
            <span className={styles.tag}>Year: {formattedYear}</span>
          )}
        </div>
        <p className={styles.description}>
          {game.description || "No description available."}
        </p>
        <button
          className={styles.downloadBtn}
          onClick={() => onDownload(game)}
        >
          <span className={styles.btnIcon}>⬇️</span>
          Download
        </button>
      </div>
    </div>
  );
}
