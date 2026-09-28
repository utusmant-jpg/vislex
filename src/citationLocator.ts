// R02 — resolving a citation locator to the exact text a viewer must display.
// Pinned R-form locators open the immutable extraction revision they name;
// legacy L-form locators open the active text. Pure logic so the grammar is
// unit-testable against the same fixtures as the Rust resolver.

export type PinnedTextRequest = { revision: number; start: number };

export function parsePinnedTextLocator(locator: string | undefined | null): PinnedTextRequest | null {
  if (!locator) return null;
  const pinned = /^R([1-9]\d*)L([1-9]\d*)-L[1-9]\d*$/.exec(locator);
  if (!pinned) return null;
  return { revision: Number(pinned[1]), start: Number(pinned[2]) };
}

export function lineStartOf(locator: string | undefined | null): number {
  const pinned = parsePinnedTextLocator(locator);
  if (pinned) return pinned.start;
  const legacy = /^L(\d+)/.exec(locator ?? '');
  return legacy ? Number(legacy[1]) : 1;
}
