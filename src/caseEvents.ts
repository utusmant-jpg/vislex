type CaseIdentity = { id: string; session_epoch?: number; event_seq?: number } | null;
type CaseEvent = { case_id: string | null; session_epoch: number; event_seq: number };
type Listen = (name: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;

function validEvent(value: unknown): value is CaseEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (typeof event.case_id === 'string' || event.case_id === null)
    && Number.isSafeInteger(event.session_epoch) && (event.session_epoch as number) >= 0
    && Number.isSafeInteger(event.event_seq) && (event.event_seq as number) > 0;
}

/** Subscribe to the native sequence while retaining a short fallback for older builds. */
export async function subscribeCaseChanges(
  listen: Listen,
  getCurrent: () => CaseIdentity,
  refresh: () => Promise<void>,
  summary: (caseId: string, epoch: number) => Promise<unknown>,
): Promise<() => void> {
  let legacyTimer: ReturnType<typeof setTimeout> | null = null;
  let pairedLegacy = 0;
  let pairExpiry: ReturnType<typeof setTimeout> | null = null;
  let lastSeen = 0;
  let lastIdentity = '';
  const onEvent = (value: unknown) => {
    if (!validEvent(value)) return;
    pairedLegacy += 1;
    if (pairExpiry) clearTimeout(pairExpiry);
    pairExpiry = setTimeout(() => { pairedLegacy = 0; pairExpiry = null; }, 250);
    const current = getCurrent();
    if (!current || current.id !== value.case_id || current.session_epoch !== value.session_epoch) return;
    const identity = `${current.id}:${current.session_epoch}`;
    const known = identity === lastIdentity ? Math.max(lastSeen, current.event_seq ?? 0) : current.event_seq ?? 0;
    if (value.event_seq <= known) return;
    lastIdentity = identity;
    lastSeen = value.event_seq;
    if (legacyTimer) { clearTimeout(legacyTimer); legacyTimer = null; }
    if (value.event_seq > known + 1) {
      const caseId = current.id, epoch = value.session_epoch;
      void summary(caseId, epoch).catch(() => undefined).then(() => {
        const active = getCurrent();
        return active?.id === caseId && active.session_epoch === epoch ? refresh() : undefined;
      }).catch(() => undefined);
    } else {
      void refresh().catch(() => undefined);
    }
  };
  const onLegacy = () => {
    if (pairedLegacy) { pairedLegacy -= 1; return; }
    if (legacyTimer) clearTimeout(legacyTimer);
    legacyTimer = setTimeout(() => { legacyTimer = null; void refresh().catch(() => undefined); }, 60);
  };
  const [stopEvent, stopLegacy] = await Promise.all([
    listen('case-event', event => onEvent(event.payload)),
    listen('case-changed', onLegacy),
  ]);
  return () => {
    if (legacyTimer) clearTimeout(legacyTimer);
    if (pairExpiry) clearTimeout(pairExpiry);
    stopEvent(); stopLegacy();
  };
}
