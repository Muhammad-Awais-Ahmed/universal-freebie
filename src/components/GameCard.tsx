"use client";

import styles from "./GameCard.module.css";
import { formatYearDisplay } from "@/utils/formatters";
import { DownloadCloud, Play, Loader2, Calendar } from "lucide-react";
import GameArtwork from "@/components/GameArtwork";

interface Game {
  id: string;
  title: string;
  source: string;
  description?: string;
  year?: string | number;
  icon?: string;
  thumbnail?: string;
  url?: string;
}

function getSourceClass(source: string): string {
  const s = (source || "").toLowerCase();
  if (s.includes("official standalone")) return styles.badgeOfficial;
  return styles.badgeDefault;
}

export default function GameCard({
  game,
  isInstalled,
  isChecking,
  isBusy,
  onInstall,
  onPlay,
}: {
  game: Game;
  isInstalled: boolean;
  isChecking: boolean;
  isBusy: boolean;
  onInstall: (game: Game) => void;
  onPlay: (game: Game) => void;
}) {
  const formattedYear = formatYearDisplay(game.year);

  return (
    <div className={styles.card}>
      <div className={styles.imageContainer}>
        <GameArtwork
          title={game.title}
          imageUrl={game.thumbnail}
          icon={game.icon}
          imageClassName={styles.image}
          fallbackClassName={styles.imageFallback}
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
          {game.year && (
            <span className={`${styles.tag} ${styles.tagRed}`}>
              <Calendar className="w-3 h-3" />
              {formattedYear}
            </span>
          )}
        </div>

        <p className={styles.description}>
          {game.description || "No description is available yet."}
        </p>

        <button
          type="button"
          className={styles.downloadBtn}
          onClick={() => (isInstalled ? onPlay(game) : onInstall(game))}
          disabled={isChecking || isBusy}
          aria-label={
            isChecking ? `Checking installation status for ${game.title}`
              : isBusy ? `Installing ${game.title}`
                : isInstalled ? `Play ${game.title}`
                  : `Download and install ${game.title}`
          }
        >
          {isChecking || isBusy
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : isInstalled
              ? <Play className="w-4 h-4" aria-hidden="true" />
              : <DownloadCloud className="w-4 h-4" aria-hidden="true" />}
          {isChecking ? "Checking…" : isBusy ? "Installing…" : isInstalled ? "Play" : "Download"}
        </button>
      </div>
    </div>
  );
}
