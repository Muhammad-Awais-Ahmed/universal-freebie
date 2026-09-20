/**
 * Formats bytes or raw numeric string into a human-readable size string (GB, MB, KB, B).
 * For example:
 *   6367527085 -> "5.93 GB"
 *   2326787172 -> "2.17 GB"
 *   524288000  -> "500 MB"
 *   1048576    -> "1 MB"
 *   512000     -> "500 KB"
 *
 * If the input is already human-formatted (e.g. "from 15.6 GB", "32.4 GB", "500 MB"),
 * it preserves it cleanly.
 */
export function formatBytes(
  bytes: number | string | undefined | null,
  decimals = 2
): string {
  if (
    bytes === undefined ||
    bytes === null ||
    bytes === "" ||
    bytes === "N/A" ||
    bytes === "Unknown" ||
    bytes === "Unknown Size"
  ) {
    return "Unknown Size";
  }

  // If input is a string
  if (typeof bytes === "string") {
    const trimmed = bytes.trim();
    // If it already contains unit letters like "GB", "MB", "KB", "TB", keep it
    if (/[a-zA-Z]/.test(trimmed) && !/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    const num = Number(trimmed);
    if (!isNaN(num)) {
      return formatNumericBytes(num, decimals);
    }
    return trimmed;
  }

  return formatNumericBytes(bytes, decimals);
}

export function formatNumericBytes(bytes: number, decimals = 2): string {
  if (bytes <= 0 || isNaN(bytes)) return "0 MB";

  const k = 1024;
  const gb = k * k * k; // 1,073,741,824
  const mb = k * k;     // 1,048,576
  const kb = k;          // 1,024

  if (bytes >= gb) {
    const val = bytes / gb;
    return `${val.toFixed(decimals)} GB`;
  }
  if (bytes >= mb) {
    const val = bytes / mb;
    const formatted = val >= 100 ? val.toFixed(1) : val.toFixed(decimals);
    return `${parseFloat(formatted)} MB`;
  }
  if (bytes >= kb) {
    const val = bytes / kb;
    return `${parseFloat(val.toFixed(1))} KB`;
  }
  return `${bytes} B`;
}

/**
 * Returns a detailed tooltip string showing exact bytes, MB equivalent, and GB.
 */
export function getSizeTooltip(size?: string | number | null): string | undefined {
  if (!size) return undefined;
  const bytes = parseSizeBytes(size);
  if (!bytes || bytes <= 0) return undefined;

  const inMB = (bytes / (1024 * 1024)).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
  const inBytes = bytes.toLocaleString();

  if (bytes >= 1024 * 1024 * 1024) {
    const inGB = (bytes / (1024 * 1024 * 1024)).toFixed(2);
    return `${inGB} GB (~${inMB} MB / ${inBytes} bytes)`;
  }
  return `${inMB} MB (${inBytes} bytes)`;
}

/**
 * Parses size strings (e.g. "15.6 GB", "500 MB", "6367527085") into numeric bytes for sorting.
 */
export function parseSizeBytes(size?: string | number | null): number {
  if (!size) return 0;
  if (typeof size === "number") return size;
  const str = String(size).trim();
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  const match = str.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "TB") return val * 1024 * 1024 * 1024 * 1024;
  if (unit === "GB") return val * 1024 * 1024 * 1024;
  if (unit === "MB") return val * 1024 * 1024;
  if (unit === "KB") return val * 1024;
  return val;
}

/**
 * Extracts a 4-digit release year (1970 - 2035) from strings like "2023",
 * "October 14, 2023", "2023-11-05T12:00:00Z", etc.
 */
export function extractYearNumber(year?: string | number | null): number | null {
  if (!year) return null;
  const str = String(year).trim();
  if (!str || str.toLowerCase().includes("unknown") || str === "n/a") return null;

  const match = str.match(/\b(19\d\d|20\d\d)\b/);
  if (match) {
    const yr = parseInt(match[1], 10);
    if (yr >= 1970 && yr <= 2035) return yr;
  }
  return null;
}

/**
 * Formats a clean year string for UI badge display.
 */
export function formatYearDisplay(year?: string | number | null): string {
  const yr = extractYearNumber(year);
  if (yr) return String(yr);
  if (
    typeof year === "string" &&
    year.trim() &&
    !year.toLowerCase().includes("unknown") &&
    year.trim() !== "N/A"
  ) {
    return year.trim();
  }
  return "Unknown Year";
}
