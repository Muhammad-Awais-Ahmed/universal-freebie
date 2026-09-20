"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gamepad2, Home, DownloadCloud, Library, Settings, Zap } from "lucide-react";
import styles from "./SidebarNav.module.css";

const navLinks = [
  { href: "/", icon: Home, label: "Home" },
  { href: "/games", icon: DownloadCloud, label: "Browse Games" },
  { href: "/library", icon: Library, label: "Library" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

export default function SidebarNav() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside className={styles.sidebar}>
      {/* Brand */}
      <div className={styles.brand}>
        <img src="/logo.jpg" alt="Universal Freebie Logo" className={styles.logoImg} />
      </div>

      {/* Navigation */}
      <nav className={styles.nav}>
        {navLinks.map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.navLink} ${isActive(href) ? styles.navLinkActive : ""}`}
          >
            <Icon className={styles.navIcon} />
            <span className={styles.navLabel}>{label}</span>
          </Link>
        ))}
      </nav>

      {/* Bottom Status */}
      <div className={styles.bottom}>
        <div className={styles.statusBadge}>
          <div className={styles.statusRow}>
            <div className={styles.statusDot} />
            <Zap style={{ width: 10, height: 10, color: "#7c3aed" }} />
          </div>
          <div className={styles.statusTitle}>Online &amp; Peer Accelerated</div>
          <div className={styles.statusSub}>Faster Downloads · More Speed</div>
        </div>
      </div>
    </aside>
  );
}
