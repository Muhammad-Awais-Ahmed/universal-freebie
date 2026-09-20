import styles from "./page.module.css";
import DownloadsSection from "@/components/DownloadsSection";
import { DownloadCloud, Library, Layers, Zap, ShieldCheck } from "lucide-react";
import BackgroundVideo from "@/components/BackgroundVideo";

export default function HomePage() {
  return (
    <div className={styles.page}>
      <BackgroundVideo />

      {/* ═══ Hero ═══ */}
      <section className={styles.hero}>
        <div className={styles.heroGlow} />

        <div className={styles.content}>
          <h1 className={styles.heroTitle}>
            YOUR ULTIMATE
            <span className={styles.heroAccent}>GAME HUB</span>
          </h1>

          <p className={styles.heroSub}>
            Search, download and launch your favorite games<br />
            from multiple sources — all in one place.
          </p>

          {/* CTA Buttons */}
          <div className={styles.ctas}>
            <a href="/games" className={styles.ctaPrimary}>
              <div className={styles.ctaIcon}>
                <DownloadCloud style={{ width: 15, height: 15 }} />
              </div>
              <div>
                <div className={styles.ctaTitle}>Browse Games</div>
                <div className={styles.ctaSub}>Explore and download your favorite games</div>
              </div>
              <span className={styles.ctaArrow}>›</span>
            </a>

            <a href="/library" className={styles.ctaSecondary}>
              <div className={styles.ctaIcon}>
                <Library style={{ width: 15, height: 15, color: "#7c3aed" }} />
              </div>
              <div>
                <div className={styles.ctaTitle}>MY Library</div>
                <div className={styles.ctaSub}>View your installed games</div>
              </div>
              <span className={styles.ctaArrow}>›</span>
            </a>
          </div>
        </div>
      </section>

      {/* ═══ Recent Downloads ═══ */}
      <DownloadsSection />
    </div>
  );
}
