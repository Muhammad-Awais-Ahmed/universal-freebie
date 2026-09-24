"use client";

import { useState, useMemo } from "react";
import SearchModule from "@/components/SearchModule";
import GameCard from "@/components/GameCard";
import LinkDownload from "@/components/LinkDownload";
import { extractYearNumber, parseSizeBytes } from "@/utils/formatters";
import styles from "./games.module.css";
import searchStyles from "@/components/Search.module.css";
import { Calendar, ArrowUpDown, X, ChevronRight, Archive, Flame, Gamepad2, HardDrive } from "lucide-react";

const sourceFilters = [
  { key: "archive", label: "Archive.org" },
  { key: "fitgirl", label: "FitGirl" },
  { key: "steamunlocked", label: "SteamUnlocked" },
];

const FEATURED_SOURCES = [
  {
    key: "archive",
    label: "Archive.org",
    desc: "Open-access digital library",
    color: "#22d3ee",
    bg: "rgba(34,211,238,0.08)",
    border: "rgba(34,211,238,0.2)",
    icon: Archive,
  },
  {
    key: "fitgirl",
    label: "FitGirl Repacks",
    desc: "Compact high-quality repacks",
    color: "#ef4444",
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.2)",
    icon: Flame,
  },
  {
    key: "steamunlocked",
    label: "SteamUnlocked",
    desc: "Pre-installed ready-to-play",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.08)",
    border: "rgba(34,197,94,0.2)",
    icon: Gamepad2,
  },
];

export default function GamesPage() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, boolean>>({
    archive: true,
    fitgirl: true,
    steamunlocked: true,
  });
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedYear, setSelectedYear] = useState<string>("all");
  const [sizeFilter, setSizeFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("relevance");

  const toggleFilter = (key: string) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setHasSearched(true);
    setSelectedYear("all");
    setSizeFilter("all");
    setSourceFilter("all");
    setSortBy("relevance");
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const activeSources = Object.entries(filters).filter(([, v]) => v).map(([k]) => k);
      const res = await ipcRenderer.invoke("search-games", query, activeSources);
      setResults(res || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleDownload = async (game: any) => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("start-download", game);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  const handleSourceSearch = async (sourceKey: string) => {
    // Featured Source card clicked → search that source for popular games.
    // Use a broad query so the provider returns its top/featured titles.
    const sourceQuery = "games";
    setFilters({ archive: false, fitgirl: false, steamunlocked: false, [sourceKey]: true });
    setQuery(sourceQuery);
    setSearching(true);
    setHasSearched(true);
    setSelectedYear("all");
    setSizeFilter("all");
    setSourceFilter("all");
    setSortBy("relevance");
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const res = await ipcRenderer.invoke("search-games", sourceQuery, [sourceKey]);
      setResults(res || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const yearStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let unknownCount = 0;
    let count2024Plus = 0, count2020To2023 = 0, count2015To2019 = 0;
    let count2010To2014 = 0, count2000To2009 = 0, countPre2000 = 0;
    results.forEach((game) => {
      const yr = extractYearNumber(game.year);
      if (yr) {
        counts[String(yr)] = (counts[String(yr)] || 0) + 1;
        if (yr >= 2024) count2024Plus++;
        else if (yr >= 2020) count2020To2023++;
        else if (yr >= 2015) count2015To2019++;
        else if (yr >= 2010) count2010To2014++;
        else if (yr >= 2000) count2000To2009++;
        else countPre2000++;
      } else { unknownCount++; }
    });
    const uniqueYears = Object.keys(counts).map(Number).sort((a, b) => b - a);
    return { counts, uniqueYears, unknownCount, ranges: { "2024+": count2024Plus, "2020-2023": count2020To2023, "2015-2019": count2015To2019, "2010-2014": count2010To2014, "2000-2009": count2000To2009, "pre-2000": countPre2000 } };
  }, [results]);

  const sizeStats = useMemo(() => {
    let unknown = 0, lt1 = 0, r1to5 = 0, r5to15 = 0, r15to30 = 0, gt30 = 0;
    results.forEach((game) => {
      const bytes = parseSizeBytes(game.size);
      if (bytes <= 0) unknown++;
      else if (bytes < 1024 * 1024 * 1024) lt1++;
      else if (bytes < 5 * 1024 * 1024 * 1024) r1to5++;
      else if (bytes < 15 * 1024 * 1024 * 1024) r5to15++;
      else if (bytes < 30 * 1024 * 1024 * 1024) r15to30++;
      else gt30++;
    });
    return { unknown, lt1, r1to5, r5to15, r15to30, gt30 };
  }, [results]);

  const sourceStats = useMemo(() => {
    let archive = 0, fitgirl = 0, steamunlocked = 0, other = 0;
    results.forEach((game) => {
      const src = (game.source || "").toLowerCase();
      if (src.includes("archive")) archive++;
      else if (src.includes("fitgirl")) fitgirl++;
      else if (src.includes("steam")) steamunlocked++;
      else other++;
    });
    return { archive, fitgirl, steamunlocked, other };
  }, [results]);

  const filteredResults = useMemo(() => {
    let list = results;
    if (selectedYear !== "all") {
      list = list.filter((game) => {
        const yr = extractYearNumber(game.year);
        if (selectedYear === "unknown") return yr === null;
        if (selectedYear === "2024+") return yr !== null && yr >= 2024;
        if (selectedYear === "2020-2023") return yr !== null && yr >= 2020 && yr <= 2023;
        if (selectedYear === "2015-2019") return yr !== null && yr >= 2015 && yr <= 2019;
        if (selectedYear === "2010-2014") return yr !== null && yr >= 2010 && yr <= 2014;
        if (selectedYear === "2000-2009") return yr !== null && yr >= 2000 && yr <= 2009;
        if (selectedYear === "pre-2000") return yr !== null && yr < 2000;
        return yr === Number(selectedYear);
      });
    }
    if (sizeFilter !== "all") {
      list = list.filter((game) => {
        const bytes = parseSizeBytes(game.size);
        if (sizeFilter === "unknown") return bytes <= 0;
        if (sizeFilter === "lt-1gb") return bytes > 0 && bytes < 1024 * 1024 * 1024;
        if (sizeFilter === "1-5gb") return bytes >= 1024 * 1024 * 1024 && bytes < 5 * 1024 * 1024 * 1024;
        if (sizeFilter === "5-15gb") return bytes >= 5 * 1024 * 1024 * 1024 && bytes < 15 * 1024 * 1024 * 1024;
        if (sizeFilter === "15-30gb") return bytes >= 15 * 1024 * 1024 * 1024 && bytes < 30 * 1024 * 1024 * 1024;
        if (sizeFilter === "gt-30gb") return bytes >= 30 * 1024 * 1024 * 1024;
        return true;
      });
    }
    if (sourceFilter !== "all") {
      list = list.filter((game) => {
        const src = (game.source || "").toLowerCase();
        if (sourceFilter === "archive") return src.includes("archive");
        if (sourceFilter === "fitgirl") return src.includes("fitgirl");
        if (sourceFilter === "steamunlocked") return src.includes("steam");
        if (sourceFilter === "other") return !src.includes("archive") && !src.includes("fitgirl") && !src.includes("steam");
        return true;
      });
    }
    return list;
  }, [results, selectedYear, sizeFilter, sourceFilter]);

  const displayResults = useMemo(() => {
    if (sortBy === "relevance") return filteredResults;
    const copy = [...filteredResults];
    if (sortBy === "year-desc") copy.sort((a, b) => (extractYearNumber(b.year) || 0) - (extractYearNumber(a.year) || 0));
    else if (sortBy === "year-asc") copy.sort((a, b) => (extractYearNumber(a.year) || 9999) - (extractYearNumber(b.year) || 9999));
    else if (sortBy === "size-desc") copy.sort((a, b) => parseSizeBytes(b.size) - parseSizeBytes(a.size));
    else if (sortBy === "size-asc") copy.sort((a, b) => (parseSizeBytes(a.size) || Infinity) - (parseSizeBytes(b.size) || Infinity));
    else if (sortBy === "title-asc") copy.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    return copy;
  }, [filteredResults, sortBy]);

  const topQuickYears = useMemo(() => yearStats.uniqueYears.slice(0, 6), [yearStats.uniqueYears]);

  const renderToolbar = () => {
    if (results.length === 0) return null;
    return (
      <div className={searchStyles.toolbarWrapper}>
        <div className={searchStyles.toolbar}>
          <div className={searchStyles.toolbarStats}>
            <span>Showing <strong>{displayResults.length}</strong> of <strong>{results.length}</strong> games</span>
            {selectedYear !== "all" && (
              <span className={searchStyles.activeFilterBadge}>
                Year: {selectedYear}
                <button className={searchStyles.clearBtn} onClick={() => setSelectedYear("all")} title="Clear Year Filter">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )}
            {sizeFilter !== "all" && (
              <span className={searchStyles.activeFilterBadge}>
                Size: {sizeFilter}
                <button className={searchStyles.clearBtn} onClick={() => setSizeFilter("all")} title="Clear Size Filter">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )}
            {sourceFilter !== "all" && (
              <span className={searchStyles.activeFilterBadge}>
                Source: {sourceFilter}
                <button className={searchStyles.clearBtn} onClick={() => setSourceFilter("all")} title="Clear Source Filter">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )}
          </div>
          <div className={searchStyles.toolbarControls}>
            <div className={searchStyles.controlGroup}>
              <label htmlFor="source-select" className={searchStyles.controlLabel}>
                <Gamepad2 className="w-3.5 h-3.5" style={{ color: "#22c55e" }} /> Source:
              </label>
              <select id="source-select" className={searchStyles.selectDropdown} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                <option value="all">All Sources ({results.length})</option>
                {sourceStats.archive > 0 && <option value="archive">Archive.org ({sourceStats.archive})</option>}
                {sourceStats.fitgirl > 0 && <option value="fitgirl">FitGirl ({sourceStats.fitgirl})</option>}
                {sourceStats.steamunlocked > 0 && <option value="steamunlocked">SteamUnlocked ({sourceStats.steamunlocked})</option>}
                {sourceStats.other > 0 && <option value="other">Other ({sourceStats.other})</option>}
              </select>
            </div>
            <div className={searchStyles.controlGroup}>
              <label htmlFor="year-select" className={searchStyles.controlLabel}>
                <Calendar className="w-3.5 h-3.5" style={{ color: "#7c3aed" }} /> Year:
              </label>
              <select id="year-select" className={searchStyles.selectDropdown} value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
                <option value="all">All Years ({results.length})</option>
                <optgroup label="Eras / Ranges">
                  {yearStats.ranges["2024+"] > 0 && <option value="2024+">2024 &amp; Newer ({yearStats.ranges["2024+"]})</option>}
                  {yearStats.ranges["2020-2023"] > 0 && <option value="2020-2023">2020 – 2023 ({yearStats.ranges["2020-2023"]})</option>}
                  {yearStats.ranges["2015-2019"] > 0 && <option value="2015-2019">2015 – 2019 ({yearStats.ranges["2015-2019"]})</option>}
                  {yearStats.ranges["2010-2014"] > 0 && <option value="2010-2014">2010 – 2014 ({yearStats.ranges["2010-2014"]})</option>}
                  {yearStats.ranges["2000-2009"] > 0 && <option value="2000-2009">2000 – 2009 ({yearStats.ranges["2000-2009"]})</option>}
                  {yearStats.ranges["pre-2000"] > 0 && <option value="pre-2000">Pre-2000 ({yearStats.ranges["pre-2000"]})</option>}
                </optgroup>
                {yearStats.uniqueYears.length > 0 && (
                  <optgroup label="Specific Years">
                    {yearStats.uniqueYears.map((yr) => <option key={yr} value={String(yr)}>{yr} ({yearStats.counts[String(yr)]})</option>)}
                  </optgroup>
                )}
                {yearStats.unknownCount > 0 && <option value="unknown">Unknown Year ({yearStats.unknownCount})</option>}
              </select>
            </div>
            <div className={searchStyles.controlGroup}>
              <label htmlFor="size-select" className={searchStyles.controlLabel}>
                <HardDrive className="w-3.5 h-3.5" style={{ color: "#06b6d4" }} /> Size:
              </label>
              <select id="size-select" className={searchStyles.selectDropdown} value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}>
                <option value="all">All Sizes ({results.length})</option>
                {sizeStats.lt1 > 0 && <option value="lt-1gb">Under 1 GB ({sizeStats.lt1})</option>}
                {sizeStats.r1to5 > 0 && <option value="1-5gb">1 – 5 GB ({sizeStats.r1to5})</option>}
                {sizeStats.r5to15 > 0 && <option value="5-15gb">5 – 15 GB ({sizeStats.r5to15})</option>}
                {sizeStats.r15to30 > 0 && <option value="15-30gb">15 – 30 GB ({sizeStats.r15to30})</option>}
                {sizeStats.gt30 > 0 && <option value="gt-30gb">Over 30 GB ({sizeStats.gt30})</option>}
                {sizeStats.unknown > 0 && <option value="unknown">Unknown Size ({sizeStats.unknown})</option>}
              </select>
            </div>
            <div className={searchStyles.controlGroup}>
              <label htmlFor="sort-select" className={searchStyles.controlLabel}>
                <ArrowUpDown className="w-3.5 h-3.5" style={{ color: "#22d3ee" }} /> Sort:
              </label>
              <select id="sort-select" className={searchStyles.selectDropdown} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="relevance">Most Relevant</option>
                <option value="year-desc">Year (Newest First)</option>
                <option value="year-asc">Year (Oldest First)</option>
                <option value="size-desc">Size (Largest First)</option>
                <option value="size-asc">Size (Smallest First)</option>
                <option value="title-asc">Title (A – Z)</option>
              </select>
            </div>
          </div>
        </div>
        {yearStats.uniqueYears.length > 1 && (
          <div className={searchStyles.quickChips}>
            <span className={searchStyles.quickChipLabel}>Quick Filter:</span>
            <button type="button" className={`${searchStyles.quickChip} ${selectedYear === "all" ? searchStyles.quickChipActive : ""}`} onClick={() => setSelectedYear("all")}>
              All <span className={searchStyles.quickChipCount}>({results.length})</span>
            </button>
            {topQuickYears.map((yr) => (
              <button key={yr} type="button" className={`${searchStyles.quickChip} ${selectedYear === String(yr) ? searchStyles.quickChipActive : ""}`} onClick={() => setSelectedYear(String(yr))}>
                {yr} <span className={searchStyles.quickChipCount}>({yearStats.counts[String(yr)]})</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.pageWrap}>
      {/* ─── Direct Link Downloader ─── */}
      <div className={styles.downloaderWrap}>
        <LinkDownload />
      </div>

      {/* ─── Featured Sources ─── */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Featured Sources</h2>
        <div className={styles.sourcesGrid}>
          {FEATURED_SOURCES.map((src) => {
            const Icon = src.icon;
            return (
              <button
                key={src.key}
                className={styles.sourceCard}
                style={{ "--src-color": src.color, "--src-bg": src.bg, "--src-border": src.border } as any}
                onClick={() => handleSourceSearch(src.key)}
              >
                <div className={styles.sourceIcon}>
                  <Icon style={{ width: 16, height: 16, color: src.color }} />
                </div>
                <div className={styles.sourceInfo}>
                  <div className={styles.sourceName}>{src.label}</div>
                  <div className={styles.sourceDesc}>{src.desc}</div>
                </div>
                <ChevronRight style={{ width: 14, height: 14, color: src.color, marginLeft: "auto", opacity: 0.7 }} />
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Game Search ─── */}
      <div className={styles.searchWrap}>
        <SearchModule
          title="Download Games"
          subtitle="Search across multiple sources for free games"
          searchPlaceholder="Search for games..."
          filters={sourceFilters}
          filterState={filters}
          onFilterToggle={toggleFilter}
          searchQuery={query}
          onSearchChange={setQuery}
          onSearch={handleSearch}
          isSearching={searching}
          hasSearched={hasSearched}
          toolbar={renderToolbar()}
          emptyTitle={
            results.length > 0 && displayResults.length === 0
              ? `No games match the current filters${selectedYear !== "all" ? ` (Year: ${selectedYear})` : ""}${sizeFilter !== "all" ? ` (Size: ${sizeFilter})` : ""}${sourceFilter !== "all" ? ` (Source: ${sourceFilter})` : ""}`
              : undefined
          }
          emptyText={
            results.length > 0 && displayResults.length === 0
              ? "Try selecting a different year/size/source or clear the filters."
              : undefined
          }
        >
          {displayResults.map((game, i) => (
            <GameCard key={game.id || i} game={game} onDownload={handleDownload} />
          ))}
        </SearchModule>
      </div>
    </div>
  );
}
