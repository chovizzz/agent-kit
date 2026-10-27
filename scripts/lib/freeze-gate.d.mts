export const FREEZE_FILE: string;
export const FROZEN_VERSION: string;
export function isFrozen(root: string): boolean;
export function freezeViolations(root: string): string[];
export function frozenVersionViolations(root: string): string[];
