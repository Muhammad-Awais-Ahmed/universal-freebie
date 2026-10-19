/**
 * Shared Games-search store.
 *
 * The search state (query, active sources, last results) lives at module level
 * so it survives tab/route switches: leaving the Games page and coming back
 * restores the exact query and results instantly, without refetching.
 *
 * - `useSyncExternalStore` gives tear-free React 18/19 subscriptions.
 * - State is mirrored into `sessionStorage` (debounced) so even a full reload
 *   within the session keeps the last search.
 * - The server snapshot is a frozen constant, keeping SSR/SSG safe.
 * - A small in-memory cache keyed by query+sources makes revisiting an earlier
 *   query instant (cleared on page reload).
 */

'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'uf:games-search';
const PERSIST_DEBOUNCE_MS = 250;

export interface GameResult {
  id: string;
  title: string;
  source: string;
  description?: string;
  year?: string | number;
  size?: string | number;
  thumbnail?: string;
  url?: string;
  [key: string]: unknown;
}

export type SearchFilters = {
  archive: boolean;
  fitgirl: boolean;
  steamunlocked: boolean;
};

export interface SearchState {
  query: string;
  filters: SearchFilters;
  results: GameResult[];
  hasSearched: boolean;
  /** Normalized (trimmed/lowercased) query the current results belong to. */
  searchedQuery: string;
  /** Sorted source keys the current results belong to. */
  searchedSources: string;
  searching: boolean;
  selectedYear: string;
  sizeFilter: string;
  sourceFilter: string;
  sortBy: string;
}

export const DEFAULT_FILTERS: SearchFilters = {
  archive: true,
  fitgirl: true,
  steamunlocked: true,
};

const SERVER_STATE: SearchState = Object.freeze({
  query: '',
  filters: DEFAULT_FILTERS,
  results: [],
  hasSearched: false,
  searchedQuery: '',
  searchedSources: '',
  searching: false,
  selectedYear: 'all',
  sizeFilter: 'all',
  sourceFilter: 'all',
  sortBy: 'relevance',
});

let state: SearchState = { ...SERVER_STATE, filters: DEFAULT_FILTERS };
const listeners = new Set<() => void>();
const resultCache = new Map<string, GameResult[]>();

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function sourceKeysToKey(sources: SearchFilters | string[]): string {
  const keys = Array.isArray(sources)
    ? sources
    : (Object.keys(sources) as (keyof SearchFilters)[]).filter((k) => sources[k]);
  return [...keys].sort().join(',');
}

function cacheKey(query: string, sourcesKey: string): string {
  return `${normalizeQuery(query)}::${sourcesKey}`;
}

export function getCachedResults(query: string, sourcesKey: string): GameResult[] | null {
  return resultCache.get(cacheKey(query, sourcesKey)) ?? null;
}

export function setCachedResults(query: string, sourcesKey: string, results: GameResult[]): void {
  resultCache.set(cacheKey(query, sourcesKey), results);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<SearchState>): void {
  state = { ...state, ...patch };
  emit();
  schedulePersist();
}

function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const { searching, ...persisted } = state;
      void searching;
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage may be unavailable (private mode/quota); state still lives in memory.
    }
  }, PERSIST_DEBOUNCE_MS);
}

function hydrateOnce(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<SearchState>;
    if (!saved || typeof saved !== 'object') return;
    state = {
      ...SERVER_STATE,
      ...saved,
      filters: { ...DEFAULT_FILTERS, ...(saved.filters ?? {}) },
      searching: false,
      results: Array.isArray(saved.results) ? saved.results : [],
    };
    emit();
  } catch {
    // Ignore corrupted storage and start fresh.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SearchState {
  return state;
}

function getServerSnapshot(): SearchState {
  return SERVER_STATE;
}

export function useSearchStore(): SearchState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    hydrateOnce();
  }, []);
  return snapshot;
}

export const searchActions = {
  setQuery(query: string): void {
    setState({ query });
  },

  setFilters(filters: SearchFilters): void {
    setState({ filters });
  },

  toggleFilter(key: string): void {
    const filterKey = key as keyof SearchFilters;
    setState({ filters: { ...state.filters, [filterKey]: !state.filters[filterKey] } });
  },

  setSelectedYear(selectedYear: string): void {
    setState({ selectedYear });
  },

  setSizeFilter(sizeFilter: string): void {
    setState({ sizeFilter });
  },

  setSourceFilter(sourceFilter: string): void {
    setState({ sourceFilter });
  },

  setSortBy(sortBy: string): void {
    setState({ sortBy });
  },

  /**
   * Mark a search as started (synchronously, before the async IPC resolves)
   * and reset result-scoped filters, mirroring the original submit behavior.
   */
  beginSearch(rawQuery: string, sources: SearchFilters | string[]): string {
    const searchedQuery = normalizeQuery(rawQuery);
    setState({
      searching: true,
      hasSearched: true,
      searchedQuery,
      searchedSources: sourceKeysToKey(sources),
      selectedYear: 'all',
      sizeFilter: 'all',
      sourceFilter: 'all',
      sortBy: 'relevance',
    });
    return searchedQuery;
  },

  finishSearch(rawQuery: string, results: GameResult[]): void {
    const searchedQuery = normalizeQuery(rawQuery);
    if (searchedQuery !== state.searchedQuery) return; // stale response
    setState({ searching: false, results });
  },

  failSearch(rawQuery: string): void {
    const searchedQuery = normalizeQuery(rawQuery);
    if (searchedQuery !== state.searchedQuery) return; // stale response
    setState({ searching: false, results: [] });
  },

  /** Show cached results instantly for a query+sources combination. */
  applyCachedResults(rawQuery: string, sources: SearchFilters | string[], results: GameResult[]): void {
    const searchedQuery = normalizeQuery(rawQuery);
    setState({
      searching: false,
      hasSearched: true,
      searchedQuery,
      searchedSources: sourceKeysToKey(sources),
      results,
      selectedYear: 'all',
      sizeFilter: 'all',
      sourceFilter: 'all',
      sortBy: 'relevance',
    });
  },
};

/** Stable callback for components that update the query while typing. */
export function useSetQuery(): (query: string) => void {
  return useCallback((query: string) => searchActions.setQuery(query), []);
}
