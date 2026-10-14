export const LICENSES_FILE: string;
export const EXPECTED_BUNDLED: string[];
export const THIN_ENTRY_MAX_BYTES: number;
export const NO_LICENSE_FILE_OK: string[];
export const NO_LICENSE_FILE_MARKER: string;
export function specifierAllowed(spec: string): boolean;
export function scanSpecifiers(
  code: string,
  filename?: string,
): { kind: 'import' | 'export' | 'dynamic-import' | 'require'; spec: string | null }[];
export function detectBundledPackages(texts: Iterable<string>): Map<string, string>;
export function parseLicenses(text: string): { id: string; license: string; body: string }[];
export interface BundleViolation {
  code: string;
  path?: string;
  message: string;
}
export function checkBundle(input: {
  pkg: { dependencies?: Record<string, string>; bin?: string | Record<string, string> };
  files: Map<string, string | Uint8Array>;
  symlinks?: string[];
  integrityPaths?: Iterable<string>;
  homeDir?: string;
}): BundleViolation[];
export function readDist(
  root: string,
  distRel?: string,
): { files: Map<string, Uint8Array>; symlinks: string[] };
