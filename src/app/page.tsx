import styles from "./page.module.css";
import DownloadsSection from "@/components/DownloadsSection";

export default function HomePage() {
  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.content}>
          <h1 className={styles.title}>
            Universal
            <br />
            <span className={styles.accent}>Freebie</span>
          </h1>
          <p className={styles.subtitle}>
            Download free games from multiple sources. Search, download, and manage
            your library all in one place.
          </p>
          <div className={styles.actions}>
            <a href="/games" className={styles.primaryBtn}>
              Browse Games
            </a>
          </div>
          <div className={styles.stats}>
            <div className={styles.statItem}>
              <div className={styles.statNumber}>4</div>
              <div className={styles.statLabel}>Sources</div>
            </div>
            <div className={styles.statItem}>
              <div className={styles.statNumber}>1000+</div>
              <div className={styles.statLabel}>Games</div>
            </div>
          </div>
        </div>
      </div>
      <DownloadsSection />
    </div>
  );
}
