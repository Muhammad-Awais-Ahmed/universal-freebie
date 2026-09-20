"use client";

import React from "react";
import styles from "./Search.module.css";
import { Search, Loader2, Gamepad2 } from "lucide-react";

export default function SearchModule({
  title,
  subtitle,
  searchPlaceholder,
  filters,
  filterState,
  onFilterToggle,
  searchQuery,
  onSearchChange,
  onSearch,
  isSearching,
  hasSearched,
  emptyTitle,
  emptyText,
  toolbar,
  children,
}: {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  filters: { key: string; label: string }[];
  filterState: Record<string, boolean>;
  onFilterToggle: (key: string) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSearch: (e: React.FormEvent) => void;
  isSearching: boolean;
  hasSearched: boolean;
  emptyTitle?: string;
  emptyText?: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>

        <form onSubmit={onSearch} className={styles.searchForm}>
          <div className={styles.searchBar}>
            <div className={styles.searchIcon}>
              <Search className="w-5 h-5" />
            </div>
            <input
              type="text"
              className={styles.searchInput}
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button
              type="submit"
              className={styles.searchBtn}
              disabled={isSearching || !searchQuery.trim()}
            >
              {isSearching ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Searching…
                </>
              ) : (
                "Search"
              )}
            </button>
          </div>

          {filters.length > 0 && (
            <div className={styles.filters}>
              <span className={styles.filterLabel}>Indexed Sources:</span>
              {filters.map((f) => (
                <label
                  key={f.key}
                  className={`${styles.filterChip} ${
                    filterState[f.key] ? styles.active : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={filterState[f.key]}
                    onChange={() => onFilterToggle(f.key)}
                    className={styles.hiddenCheckbox}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      filterState[f.key] ? "bg-red-500 shadow-[0_0_6px_#ef4444]" : "bg-slate-600"
                    }`}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          )}
        </form>
      </div>

      <div className={styles.resultsArea}>
        {isSearching && (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p className="font-gaming text-sm tracking-wider uppercase text-blue-400">
              Querying repackers & archives for "{searchQuery}"...
            </p>
          </div>
        )}

        {!isSearching && hasSearched && toolbar && (
          <div className={styles.toolbarWrapper}>{toolbar}</div>
        )}

        {!isSearching && hasSearched && React.Children.count(children) > 0 && (
          <div className={styles.grid}>{children}</div>
        )}

        {!isSearching && hasSearched && React.Children.count(children) === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Gamepad2 className="w-12 h-12 stroke-[1.5]" />
            </div>
            <h3>{emptyTitle || "No games found"}</h3>
            <p>{emptyText || "Try a different search keyword or enable additional indexed sources."}</p>
          </div>
        )}
      </div>
    </div>
  );
}
