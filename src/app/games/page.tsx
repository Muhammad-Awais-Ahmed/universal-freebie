"use client";

import { useState } from "react";
import SearchModule from "@/components/SearchModule";
import GameCard from "@/components/GameCard";

const sourceFilters = [
  { key: "archive", label: "Archive.org" },
  { key: "fitgirl", label: "FitGirl" },
  { key: "steamunlocked", label: "SteamUnlocked" },
  { key: "apunkagames", label: "ApunKaGames" },
  { key: "filecr", label: "FileCR" },
];

export default function GamesPage() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, boolean>>({
    archive: true,
    fitgirl: true,
    steamunlocked: true,
    apunkagames: true,
    filecr: true,
  });
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const toggleFilter = (key: string) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setHasSearched(true);

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

  return (
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
    >
      {results.map((game, i) => (
        <GameCard key={game.id || i} game={game} onDownload={handleDownload} />
      ))}
    </SearchModule>
  );
}
