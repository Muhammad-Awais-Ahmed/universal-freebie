"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SearchModule from "@/components/SearchModule";
import GameCard from "@/components/GameCard";
import GameArtwork from "@/components/GameArtwork";
import LinkDownload from "@/components/LinkDownload";
import { extractYearNumber } from "@/utils/formatters";
import styles from "./games.module.css";
import searchStyles from "@/components/Search.module.css";
import { Calendar, ArrowUpDown, X, ChevronRight, Gamepad2, Sparkles } from "lucide-react";
import standaloneCatalog from "@/data/standaloneGames.json";
import {
  useSearchStore,
  searchActions,
  normalizeQuery,
  sourceKeysToKey,
  getCachedResults,
  setCachedResults,
} from "@/lib/searchStore";

const sourceFilters = [
  { key: "officialStandalone", label: "Official standalone games" },
];

const FEATURED_SOURCES = [
  {
    key: "officialStandalone",
    label: "Official standalone games",
    desc: "Direct downloads from each game's official project",
    color: "#38bdf8",
    bg: "rgba(56,189,248,0.08)",
    border: "rgba(56,189,248,0.2)",
    icon: Gamepad2,
  },
];

interface FeaturedGame {
  id: string;
  title: string;
  series: string;
  year: number;
  icon: string;
  thumbnail: string;
  version: string;
  description: string;
  downloadUrl: string;
  filename: string;
  homepage: string;
  downloadSize: string;
}

interface InstallStatus {
  installed: boolean;
  phase: string | null;
  error?: string;
}

const FEATURED_GAMES: FeaturedGame[] = standaloneCatalog.games;
const GAME_RESULTS = FEATURED_GAMES.map((game) => ({
  ...game,
  source: "Official standalone download",
}));

export default function GamesPage() {
  // Search state lives in a module-level store so results persist across
  // tab/route switches and reloads (see src/lib/searchStore.ts).
  const {
    query,
    filters,
    results,
    searching,
    hasSearched,
    selectedYear,
    sourceFilter,
    sortBy,
  } = useSearchStore();

  const setQuery = searchActions.setQuery;
  const setSelectedYear = searchActions.setSelectedYear;
  const setSourceFilter = searchActions.setSourceFilter;
  const setSortBy = searchActions.setSortBy;

  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [downloadNotice, setDownloadNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [installStatusLoading, setInstallStatusLoading] = useState(true);

  const toggleFilter = (key: string) => {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) return;
    const filterKey = key as keyof typeof filters;
    const nextFilters = { ...filters, [filterKey]: !filters[filterKey] };
    searchActions.setFilters(nextFilters);
    if (hasSearched) {
      const activeSources = Object.entries(nextFilters).filter(([, enabled]) => enabled).map(([source]) => source);
      runSearch(query, { sources: activeSources, force: true });
    }
  };

  const runSearch = useCallback((rawQuery: string, opts?: { force?: boolean; sources?: string[] }) => {
    const q = normalizeQuery(rawQuery);
    const activeSources = opts?.sources ?? Object.entries(filters).filter(([, enabled]) => enabled).map(([source]) => source);
    const sourcesKey = sourceKeysToKey(activeSources);
    const cached = !opts?.force ? getCachedResults(q, sourcesKey) : null;
    if (cached) {
      setSearchError(null);
      searchActions.applyCachedResults(q, activeSources, cached);
      return;
    }

    const tokens = q.split(" ").filter(Boolean);
    const matches = (activeSources.includes("officialStandalone") ? GAME_RESULTS : []).filter((game) => {
      const haystack = normalizeQuery(`${game.title} ${game.series} ${game.description} ${game.year} ${game.version}`);
      return tokens.every((token) => haystack.includes(token));
    });
    setSearchError(null);
    searchActions.beginSearch(q, activeSources);
    setCachedResults(q, sourcesKey, matches);
    searchActions.finishSearch(q, matches);
  }, [filters]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    runSearch(query, { force: true });
  };

  const handleQueryChange = (value: string) => {
    setSearchError(null);
    if (!value.trim()) {
      searchActions.clearSearch();
      return;
    }
    setQuery(value);
    runSearch(value);
  };

  const handleStandaloneAction = async (game: { id: string; title: string }, action: "install" | "play") => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const channel = action === "play" ? "play-standalone-game" : "install-standalone-game";
      const result = await ipcRenderer.invoke(channel, game.id);
      if (!result || result.ok !== true) {
        throw new Error(result?.error || `Could not ${action} ${game.title}.`);
      }
      if (action === "install" && result.alreadyInstalled) {
        setInstallStatus((current) => ({ ...current, [game.id]: { installed: true, phase: "installed" } }));
        setDownloadNotice({ type: "success", text: `${game.title} is already installed and ready to play.` });
      } else if (action === "install") {
        setInstallStatus((current) => ({ ...current, [game.id]: { installed: false, phase: result.phase || "downloading" } }));
        setDownloadNotice({ type: "success", text: `Downloading and installing ${game.title} from its official source.` });
      } else {
        setDownloadNotice({ type: "success", text: `Launching ${game.title}.` });
      }
    } catch (err) {
      setDownloadNotice({
        type: "error",
        text: err instanceof Error ? err.message : `Could not ${action} ${game.title}.`,
      });
    }
  };

  const handleSourceSearch = () => {
    searchActions.setFilters({ officialStandalone: true });
    searchActions.setQuery("");
    runSearch("", { sources: ["officialStandalone"], force: true });
  };

  const handleSuggestionSearch = (game: FeaturedGame) => {
    searchActions.setFilters({ officialStandalone: true });
    searchActions.setQuery(game.title);
    runSearch(game.title, { sources: ["officialStandalone"] });
  };

  const toggleSuggestionExpanded = (id: string) => {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  useEffect(() => {
    let alive = true;
    let ipcRenderer: any;
    let statusRequestId = 0;
    let gameStateRevision = 0;
    const gameRevisions = new Map<string, number>();
    try {
      ipcRenderer = (window as any).require("electron").ipcRenderer;
    } catch (error) {
      setInstallStatusLoading(false);
      setDownloadNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Standalone game status is unavailable outside the desktop app.",
      });
      return () => { alive = false; };
    }

    const refreshStatus = async () => {
      const requestId = ++statusRequestId;
      const revisionsAtStart = new Map(gameRevisions);
      setInstallStatusLoading(true);
      try {
        const response: { games?: Record<string, InstallStatus>; error?: string } =
          await ipcRenderer.invoke("get-standalone-game-status", FEATURED_GAMES.map((game) => game.id));
        if (!alive || requestId !== statusRequestId) return;
        if (!response || response.error || !response.games) {
          throw new Error(response?.error || "Standalone game status could not be read.");
        }
        setInstallStatus((current) => {
          const next = { ...response.games };
          for (const [gameId, revision] of gameRevisions) {
            if (revision !== revisionsAtStart.get(gameId) && current[gameId]) {
              next[gameId] = current[gameId];
            }
          }
          return next;
        });
      } catch (error) {
        if (alive && requestId === statusRequestId) {
          setInstallStatusLoading(false);
          setDownloadNotice({
            type: "error",
            text: error instanceof Error ? error.message : "Standalone game status could not be read.",
          });
        }
      } finally {
        if (alive && requestId === statusRequestId) setInstallStatusLoading(false);
      }
    };

    const handleGameState = (_event: unknown, state: { gameId?: string; phase?: string; error?: string }) => {
      if (!state?.gameId || !state.phase) return;
      gameRevisions.set(state.gameId, ++gameStateRevision);
      setInstallStatus((current) => ({
        ...current,
        [state.gameId as string]: {
          installed: state.phase === "installed",
          phase: state.phase || null,
          error: state.error,
        },
      }));
      if (state.phase === "error" && state.error) {
        setDownloadNotice({ type: "error", text: state.error });
      }
    };
    const handleDownloadProgress = (_event: unknown, items: Array<{
      status?: string;
      error?: string;
      meta?: { standaloneGameId?: string };
    }>) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const gameId = item.meta?.standaloneGameId;
        if (!gameId) continue;
        gameRevisions.set(gameId, ++gameStateRevision);
        const phase = item.status === "completed" ? "installing"
          : item.status === "error" || item.status === "cancelled" ? "error"
            : item.status || "downloading";
        setInstallStatus((current) => ({
          ...current,
          [gameId]: { installed: false, phase, error: item.error },
        }));
        if (phase === "error" && item.error) {
          setDownloadNotice({ type: "error", text: item.error });
        }
      }
    };

    ipcRenderer.on("standalone-game-state", handleGameState);
    ipcRenderer.on("downloads-progress", handleDownloadProgress);
    refreshStatus();
    window.addEventListener("focus", refreshStatus);
    return () => {
      alive = false;
      ipcRenderer.removeListener("standalone-game-state", handleGameState);
      ipcRenderer.removeListener("downloads-progress", handleDownloadProgress);
      window.removeEventListener("focus", refreshStatus);
    };
  }, []);

  // While a search is in flight, keep the previous results on screen as an
  // instant preview filtered by the text being typed (realtime feedback).
  const baseResults = useMemo(() => {
    if (!searching) return results;
    const tokens = normalizeQuery(query).split(" ").filter(Boolean);
    if (tokens.length === 0) return [];
    return results.filter((game) => {
      const haystack = normalizeQuery(`${game.title || ""} ${game.description || ""} ${game.year || ""}`);
      return tokens.every((token) => haystack.includes(token));
    });
  }, [searching, results, query]);

  const yearStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let unknownCount = 0;
    let count2024Plus = 0, count2020To2023 = 0, count2015To2019 = 0;
    let count2010To2014 = 0, count2000To2009 = 0, countPre2000 = 0;
    baseResults.forEach((game) => {
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
  }, [baseResults]);

  const sourceStats = useMemo(() => {
    const officialStandalone = baseResults.filter((game) =>
      (game.source || "").toLowerCase().includes("official standalone")
    ).length;
    return { officialStandalone };
  }, [baseResults]);

  const filteredResults = useMemo(() => {
    let list = baseResults;
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
    if (sourceFilter !== "all") {
      list = list.filter((game) => {
        const src = (game.source || "").toLowerCase();
        if (sourceFilter === "officialStandalone") return src.includes("official standalone");
        return true;
      });
    }
    return list;
  }, [baseResults, selectedYear, sourceFilter]);

  const displayResults = useMemo(() => {
    if (sortBy === "relevance") return filteredResults;
    const copy = [...filteredResults];
    if (sortBy === "year-desc") copy.sort((a, b) => (extractYearNumber(b.year) || 0) - (extractYearNumber(a.year) || 0));
    else if (sortBy === "year-asc") copy.sort((a, b) => (extractYearNumber(a.year) || 9999) - (extractYearNumber(b.year) || 9999));
    else if (sortBy === "title-asc") copy.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    return copy;
  }, [filteredResults, sortBy]);

  const topQuickYears = useMemo(() => yearStats.uniqueYears.slice(0, 6), [yearStats.uniqueYears]);

  const renderToolbar = () => {
    if (baseResults.length === 0) return null;
    return (
      <div className={searchStyles.toolbarWrapper}>
        <div className={searchStyles.toolbar}>
          <div className={searchStyles.toolbarStats}>
            <span>Showing <strong>{displayResults.length}</strong> of <strong>{baseResults.length}</strong> games</span>
            {selectedYear !== "all" && (
              <span className={searchStyles.activeFilterBadge}>
                Year: {selectedYear}
                <button className={searchStyles.clearBtn} onClick={() => setSelectedYear("all")} title="Clear Year Filter">
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
                <option value="all">All Sources ({baseResults.length})</option>
                {sourceStats.officialStandalone > 0 && (
                  <option value="officialStandalone">Official standalone ({sourceStats.officialStandalone})</option>
                )}
              </select>
            </div>
            <div className={searchStyles.controlGroup}>
              <label htmlFor="year-select" className={searchStyles.controlLabel}>
                <Calendar className="w-3.5 h-3.5" style={{ color: "#7c3aed" }} /> Year:
              </label>
              <select id="year-select" className={searchStyles.selectDropdown} value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
                <option value="all">All Years ({baseResults.length})</option>
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
              <label htmlFor="sort-select" className={searchStyles.controlLabel}>
                <ArrowUpDown className="w-3.5 h-3.5" style={{ color: "#22d3ee" }} /> Sort:
              </label>
              <select id="sort-select" className={searchStyles.selectDropdown} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="relevance">Most Relevant</option>
                <option value="year-desc">Year (Newest First)</option>
                <option value="year-asc">Year (Oldest First)</option>
                <option value="title-asc">Title (A – Z)</option>
              </select>
            </div>
          </div>
        </div>
        {yearStats.uniqueYears.length > 1 && (
          <div className={searchStyles.quickChips}>
            <span className={searchStyles.quickChipLabel}>Quick Filter:</span>
            <button type="button" className={`${searchStyles.quickChip} ${selectedYear === "all" ? searchStyles.quickChipActive : ""}`} onClick={() => setSelectedYear("all")}>
              All <span className={searchStyles.quickChipCount}>({baseResults.length})</span>
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

  const renderSuggestionCard = (game: FeaturedGame) => {
    const fullText = game.description.trim();
    const shortText = fullText.length > 132 ? `${fullText.slice(0, 129).trimEnd()}…` : fullText;
    const expanded = expandedIds.includes(game.id);
    const showMore = fullText.length > 0 && fullText !== shortText;
    const status = installStatus[game.id];
    const installed = status?.installed === true;
    const busy = ["downloading", "queued", "interrupted", "installing"].includes(status?.phase || "");
    return (
      <article key={game.id} className={styles.suggestionCard}>
        <button
          type="button"
          className={styles.suggestionHit}
          onClick={() => handleSuggestionSearch(game)}
          aria-label={`Search for ${game.title}`}
        >
          <div className={styles.suggestionThumb} data-game-icon={game.icon}>
            <GameArtwork
              title={game.title}
              imageUrl={game.thumbnail}
              icon={game.icon}
              imageClassName={styles.suggestionImage}
              fallbackClassName={styles.suggestionThumbFallback}
              iconClassName={styles.suggestionThumbIcon}
            />
            <span className={styles.suggestionYear}>{game.year}</span>
          </div>
          <div className={styles.suggestionBody}>
            <span className={styles.suggestionSeries}>{game.series}</span>
            <span className={styles.suggestionTitle}>{game.title}</span>
            <span className={`${styles.suggestionDesc} ${expanded ? styles.suggestionDescOpen : ""}`}>{shortText}</span>
          </div>
        </button>
        <div className={styles.suggestionFooter}>
          <span className={styles.suggestionSource}>Official ZIP · {game.downloadSize}</span>
          <div className={styles.suggestionActions}>
            {showMore && (
              <button
                type="button"
                className={styles.suggestionMore}
                onClick={() => toggleSuggestionExpanded(game.id)}
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : "More"}
              </button>
            )}
            <button
              type="button"
              className={styles.suggestionInstallAction}
              onClick={() => handleStandaloneAction(game, installed ? "play" : "install")}
              disabled={installStatusLoading || busy}
              aria-label={installed ? `Play ${game.title}` : `Download and install ${game.title}`}
            >
              {installStatusLoading ? "Checking…" : installed ? "Play" : busy ? "Installing…" : "Download"}
            </button>
          </div>
        </div>
        {expanded && fullText && <p className={styles.suggestionFullText}>{fullText}</p>}
      </article>
    );
  };

  const renderSuggestions = () => (
    <section className={styles.suggestionsSection} aria-label="All available games">
      <div className={styles.suggestionsHeader}>
        <Sparkles style={{ width: 16, height: 16, color: "#facc15" }} aria-hidden="true" />
        <div>
          <h2 className={styles.suggestionsTitle}>Browse all games</h2>
          <p className={styles.suggestionsSubtitle}>
            {FEATURED_GAMES.length} free games from official sources. Downloads are verified and added to your library after installation.
          </p>
        </div>
      </div>
      <div className={styles.suggestionsGrid}>{FEATURED_GAMES.map(renderSuggestionCard)}</div>
    </section>
  );

  return (
    <div className={styles.pageWrap}>
      {/* ─── Direct Link Downloader ─── */}
      <div className={styles.downloaderWrap}>
        <LinkDownload />
      </div>

      {/* ─── Featured Sources ─── */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Official game source</h2>
        <div className={styles.sourcesGrid}>
          {FEATURED_SOURCES.map((src) => {
            const Icon = src.icon;
            return (
              <button
                key={src.key}
                className={styles.sourceCard}
                style={{ "--src-color": src.color, "--src-bg": src.bg, "--src-border": src.border } as any}
                onClick={handleSourceSearch}
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
          title="Standalone Games"
          subtitle="Search instantly across official portable game releases. Downloads are checksum-verified, installed, and launched here."
          searchPlaceholder="Search standalone games..."
          filters={sourceFilters}
          filterState={filters}
          onFilterToggle={toggleFilter}
          searchQuery={query}
          onSearchChange={handleQueryChange}
          onSearch={handleSearch}
          isSearching={searching}
          hasSearched={hasSearched}
          searchError={searchError}
          toolbar={renderToolbar()}
          suggestions={hasSearched ? undefined : renderSuggestions()}
          emptyTitle={
            baseResults.length > 0 && displayResults.length === 0
              ? `No games match the current filters${selectedYear !== "all" ? ` (Year: ${selectedYear})` : ""}${sourceFilter !== "all" ? ` (Source: ${sourceFilter})` : ""}`
              : undefined
          }
          emptyText={
            baseResults.length > 0 && displayResults.length === 0
              ? "Try selecting a different year or source, or clear the filters."
              : undefined
          }
        >
          {displayResults.map((game, i) => (
            <GameCard
              key={game.id || i}
              game={game}
              isInstalled={installStatus[game.id]?.installed === true}
              isChecking={installStatusLoading && !installStatus[game.id]}
              isBusy={["downloading", "queued", "interrupted", "installing"].includes(installStatus[game.id]?.phase || "")}
              onInstall={(target) => handleStandaloneAction(target, "install")}
              onPlay={(target) => handleStandaloneAction(target, "play")}
            />
          ))}
        </SearchModule>
      </div>
      {downloadNotice && (
        <div
          className={downloadNotice.type === "error" ? styles.downloadNoticeError : styles.downloadNotice}
          role={downloadNotice.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {downloadNotice.text}
        </div>
      )}
    </div>
  );
}
