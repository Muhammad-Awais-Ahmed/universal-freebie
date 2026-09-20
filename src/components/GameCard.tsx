"use client";

import styles from "./GameCard.module.css";
import { formatBytes, formatYearDisplay, getSizeTooltip } from "@/utils/formatters";
import { DownloadCloud, HardDrive, Calendar, Gamepad2 } from "lucide-react";

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

  return (
    <div className={styles.card}>
      <div className={styles.imageContainer}>
        <img
          src={game.thumbnail}
          alt={game.title}
          className={styles.image}
          onError={(e) => {
            // Clean gaming controller SVG placeholder (no emoji)
            (e.target as HTMLImageElement).src =
              "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%230e1220'><rect width='100' height='100'/><path d='M30 40h40a15 15 0 0 1 15 15v10a10 10 0 0 1-18 6l-5-7H38l-5 7a10 10 0 0 1-18-6V55a15 15 0 0 1 15-15z' fill='%231e263d'/><circle cx='38' cy='52' r='3' fill='%238b5cf6'/><circle cx='62' cy='52' r='3' fill='%2306b6d4'/></svg>";
          }}
        />
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
          className={styles.downloadBtn}
          onClick={() => onDownload(game)}
        >
          <DownloadCloud className="w-4 h-4" />
          Download Game
        </button>
      </div>
    </div>
  );
}
