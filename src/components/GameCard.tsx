"use client";

import styles from "./GameCard.module.css";
import { formatBytes, formatYearDisplay, getSizeTooltip } from "@/utils/formatters";
import { DownloadCloud, HardDrive, Calendar, Gamepad2 } from "lucide-react";
import { useState } from "react";

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

function getSourceClass(source: string): string {
  const s = (source || "").toLowerCase();
  if (s.includes("fitgirl")) return styles.badgeFitgirl;
  if (s.includes("archive")) return styles.badgeArchive;
  if (s.includes("steam")) return styles.badgeSteamunlocked;
  return styles.badgeDefault;
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
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className={styles.card}>
      <div className={styles.imageContainer}>
        {game.thumbnail && !imageFailed ? (
          <img
            src={game.thumbnail}
            alt={game.title}
            className={styles.image}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className={styles.imageFallback} aria-label={`No image available for ${game.title}`}>
            <Gamepad2 aria-hidden="true" />
          </div>
        )}
        <div className={styles.imageOverlay} />
        <div className={`${styles.sourceBadge} ${getSourceClass(game.source)}`}>
          {game.source}
        </div>
      </div>

      <div className={styles.content}>
        <h3 className={styles.title} title={game.title}>
          {game.title}
        </h3>

        <div className={styles.meta}>
          {game.size && (
            <span className={`${styles.tag} ${styles.tagBlue}`} title={sizeTooltip}>
              <HardDrive className="w-3 h-3" />
              {formattedSize}
            </span>
          )}
          {game.year && (
            <span className={`${styles.tag} ${styles.tagRed}`}>
              <Calendar className="w-3 h-3" />
              {formattedYear}
            </span>
          )}
        </div>

        <p className={styles.description}>
          {game.description || "Pre-indexed verified game release package ready for high-speed download."}
        </p>

        <button
          type="button"
          className={styles.downloadBtn}
          onClick={() => onDownload(game)}
          aria-label={`Download ${game.title}`}
        >
          <DownloadCloud className="w-4 h-4" aria-hidden="true" />
          Download Game
        </button>
      </div>
    </div>
  );
}
