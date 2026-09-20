"use client";

import React from "react";
import styles from "./Search.module.css";

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
            <span className={styles.searchIcon}>🔍</span>
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
              {isSearching ? "Searching..." : "Search"}
            </button>
          </div>
          {filters.length > 0 && (
            <div className={styles.filters}>
              <span className={styles.filterLabel}>Search in:</span>
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
            <p>Scraping sources for {searchQuery}...</p>
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
            <div className={styles.emptyIcon}>🎮</div>
            <h3>{emptyTitle || "No games found"}</h3>
            <p>{emptyText || "Try a different search term or enable more sources."}</p>
          </div>
        )}
      </div>
    </div>
  );
}
