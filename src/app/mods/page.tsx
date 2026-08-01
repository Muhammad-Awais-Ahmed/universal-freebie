"use client";

import { useState } from "react";
import SearchModule from "@/components/SearchModule";
import GameCard from "@/components/GameCard";

export default function ModsPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setHasSearched(true);

    try {
      const { ipcRenderer } = (window as any).require("electron");
      const res = await ipcRenderer.invoke("search-mods", query);
      setResults(res || []);
    } catch (err) {
      console.error("Mod search failed:", err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleDownload = async (mod: any) => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("start-download", mod);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  return (
    <SearchModule
      title="Download Mods"
      subtitle="Search for game mods on ModDB"
      searchPlaceholder="Search for mods..."
      filters={[]}
      filterState={{}}
      onFilterToggle={() => {}}
      searchQuery={query}
      onSearchChange={setQuery}
      onSearch={handleSearch}
      isSearching={searching}
      hasSearched={hasSearched}
      emptyTitle="No mods found"
      emptyText="Try a different search term or check your spelling."
    >
      {results.map((mod, i) => (
        <GameCard key={mod.id || i} game={mod} onDownload={handleDownload} />
      ))}
    </SearchModule>
  );
}
