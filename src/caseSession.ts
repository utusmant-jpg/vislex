/** Capture the open-case identity used by native command preflight. */
export function caseSessionArgs(caseId: string, sessionEpoch?: number) {
  return { case_id: caseId, ...(typeof sessionEpoch === 'number' ? { session_epoch: sessionEpoch } : {}) };
}
