"use client";

import { useState, useMemo } from "react";
import SearchModule from "@/components/SearchModule";
import GameCard from "@/components/GameCard";
import LinkDownload from "@/components/LinkDownload";
import { extractYearNumber, parseSizeBytes } from "@/utils/formatters";
import styles from "@/components/Search.module.css";

const sourceFilters = [
  { key: "archive", label: "Archive.org" },
  { key: "fitgirl", label: "FitGirl" },
  { key: "steamunlocked", label: "SteamUnlocked" },
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

  // Year filter & sort state
  const [selectedYear, setSelectedYear] = useState<string>("all");
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
    setSortBy("relevance");

    try {
      const { ipcRenderer } = (window as any).require("electron");
      const activeSources = Object.entries(filters)
        .filter(([, v]) => v)
        .map(([k]) => k);

      const res = await ipcRenderer.invoke(
        "search-games",
        query,
        activeSources
      );
      setResults(res || []);
    } catch (err) {
      console.error("Search failed:", err);
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

  // Compute available years and counts from results
  const yearStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let unknownCount = 0;

    let count2024Plus = 0;
    let count2020To2023 = 0;
    let count2015To2019 = 0;
    let count2010To2014 = 0;
    let count2000To2009 = 0;
    let countPre2000 = 0;

    results.forEach((game) => {
      const yr = extractYearNumber(game.year);
      if (yr) {
        const yrStr = String(yr);
        counts[yrStr] = (counts[yrStr] || 0) + 1;

        if (yr >= 2024) count2024Plus++;
        else if (yr >= 2020) count2020To2023++;
        else if (yr >= 2015) count2015To2019++;
        else if (yr >= 2010) count2010To2014++;
        else if (yr >= 2000) count2000To2009++;
        else countPre2000++;
      } else {
        unknownCount++;
      }
    });

    const uniqueYears = Object.keys(counts)
      .map(Number)
      .sort((a, b) => b - a);

    return {
      counts,
      uniqueYears,
      unknownCount,
      ranges: {
        "2024+": count2024Plus,
        "2020-2023": count2020To2023,
        "2015-2019": count2015To2019,
        "2010-2014": count2010To2014,
        "2000-2009": count2000To2009,
        "pre-2000": countPre2000,
      },
    };
  }, [results]);

  // Filter results by selected year
  const filteredResults = useMemo(() => {
    if (selectedYear === "all") return results;

    return results.filter((game) => {
      const yr = extractYearNumber(game.year);
      if (selectedYear === "unknown") {
        return yr === null;
      }
      if (selectedYear === "2024+") {
        return yr !== null && yr >= 2024;
      }
      if (selectedYear === "2020-2023") {
        return yr !== null && yr >= 2020 && yr <= 2023;
      }
      if (selectedYear === "2015-2019") {
        return yr !== null && yr >= 2015 && yr <= 2019;
      }
      if (selectedYear === "2010-2014") {
        return yr !== null && yr >= 2010 && yr <= 2014;
      }
      if (selectedYear === "2000-2009") {
        return yr !== null && yr >= 2000 && yr <= 2009;
      }
      if (selectedYear === "pre-2000") {
        return yr !== null && yr < 2000;
      }

      return yr === Number(selectedYear);
    });
  }, [results, selectedYear]);

  // Sort filtered results
  const displayResults = useMemo(() => {
    if (sortBy === "relevance") return filteredResults;

    const copy = [...filteredResults];
    if (sortBy === "year-desc") {
      copy.sort((a, b) => (extractYearNumber(b.year) || 0) - (extractYearNumber(a.year) || 0));
    } else if (sortBy === "year-asc") {
      copy.sort((a, b) => (extractYearNumber(a.year) || 9999) - (extractYearNumber(b.year) || 9999));
    } else if (sortBy === "size-desc") {
      copy.sort((a, b) => parseSizeBytes(b.size) - parseSizeBytes(a.size));
    } else if (sortBy === "size-asc") {
      copy.sort((a, b) => (parseSizeBytes(a.size) || Infinity) - (parseSizeBytes(b.size) || Infinity));
    } else if (sortBy === "title-asc") {
      copy.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    }
    return copy;
  }, [filteredResults, sortBy]);

  // Quick chips: Top 5 distinct years, plus eras if spread out
  const topQuickYears = useMemo(() => {
    return yearStats.uniqueYears.slice(0, 6);
  }, [yearStats.uniqueYears]);

  const renderToolbar = () => {
    if (results.length === 0) return null;

    return (
      <div className={styles.toolbarWrapper}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarStats}>
            <span>
              Showing <strong>{displayResults.length}</strong> of{" "}
              <strong>{results.length}</strong> games
            </span>
            {selectedYear !== "all" && (
              <span className={styles.activeFilterBadge}>
                Year: {selectedYear}
                <button
                  className={styles.clearBtn}
                  onClick={() => setSelectedYear("all")}
                  title="Clear Year Filter"
                >
                  ✕
                </button>
              </span>
            )}
          </div>

          <div className={styles.toolbarControls}>
            <div className={styles.controlGroup}>
              <label htmlFor="year-select" className={styles.controlLabel}>
                📅 Year:
              </label>
              <select
                id="year-select"
                className={styles.selectDropdown}
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
              >
                <option value="all">All Years ({results.length})</option>

                {/* Eras / Ranges */}
                <optgroup label="Eras / Ranges">
                  {yearStats.ranges["2024+"] > 0 && (
                    <option value="2024+">2024 & Newer ({yearStats.ranges["2024+"]})</option>
                  )}
                  {yearStats.ranges["2020-2023"] > 0 && (
                    <option value="2020-2023">2020 – 2023 ({yearStats.ranges["2020-2023"]})</option>
                  )}
                  {yearStats.ranges["2015-2019"] > 0 && (
                    <option value="2015-2019">2015 – 2019 ({yearStats.ranges["2015-2019"]})</option>
                  )}
                  {yearStats.ranges["2010-2014"] > 0 && (
                    <option value="2010-2014">2010 – 2014 ({yearStats.ranges["2010-2014"]})</option>
                  )}
                  {yearStats.ranges["2000-2009"] > 0 && (
                    <option value="2000-2009">2000 – 2009 ({yearStats.ranges["2000-2009"]})</option>
                  )}
                  {yearStats.ranges["pre-2000"] > 0 && (
                    <option value="pre-2000">Pre-2000 ({yearStats.ranges["pre-2000"]})</option>
                  )}
                </optgroup>

                {/* Specific Years */}
                {yearStats.uniqueYears.length > 0 && (
                  <optgroup label="Specific Years">
                    {yearStats.uniqueYears.map((yr) => (
                      <option key={yr} value={String(yr)}>
                        {yr} ({yearStats.counts[String(yr)]})
                      </option>
                    ))}
                  </optgroup>
                )}

                {yearStats.unknownCount > 0 && (
                  <option value="unknown">Unknown Year ({yearStats.unknownCount})</option>
                )}
              </select>
            </div>

            <div className={styles.controlGroup}>
              <label htmlFor="sort-select" className={styles.controlLabel}>
                ⚡ Sort:
              </label>
              <select
                id="sort-select"
                className={styles.selectDropdown}
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
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

        {/* Quick Year Chips */}
        {yearStats.uniqueYears.length > 1 && (
          <div className={styles.quickChips}>
            <span className={styles.quickChipLabel}>Quick Filter:</span>
            <button
              type="button"
              className={`${styles.quickChip} ${selectedYear === "all" ? styles.quickChipActive : ""}`}
              onClick={() => setSelectedYear("all")}
            >
              All <span className={styles.quickChipCount}>({results.length})</span>
            </button>
            {topQuickYears.map((yr) => (
              <button
                key={yr}
                type="button"
                className={`${styles.quickChip} ${selectedYear === String(yr) ? styles.quickChipActive : ""}`}
                onClick={() => setSelectedYear(String(yr))}
              >
                {yr} <span className={styles.quickChipCount}>({yearStats.counts[String(yr)]})</span>
              </button>
            ))}
            {yearStats.ranges["2000-2009"] > 0 && (
              <button
                type="button"
                className={`${styles.quickChip} ${selectedYear === "2000-2009" ? styles.quickChipActive : ""}`}
                onClick={() => setSelectedYear("2000-2009")}
              >
                2000s <span className={styles.quickChipCount}>({yearStats.ranges["2000-2009"]})</span>
              </button>
            )}
            {yearStats.ranges["pre-2000"] > 0 && (
              <button
                type="button"
                className={`${styles.quickChip} ${selectedYear === "pre-2000" ? styles.quickChipActive : ""}`}
                onClick={() => setSelectedYear("pre-2000")}
              >
                Pre-2000 <span className={styles.quickChipCount}>({yearStats.ranges["pre-2000"]})</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <LinkDownload />
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
            ? `No games found for year "${selectedYear}"`
            : undefined
        }
        emptyText={
          results.length > 0 && displayResults.length === 0
            ? "Try selecting a different year or clear the filter to see all results."
            : undefined
        }
      >
        {displayResults.map((game, i) => (
          <GameCard key={game.id || i} game={game} onDownload={handleDownload} />
        ))}
      </SearchModule>
    </>
  );
}

