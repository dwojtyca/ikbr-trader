import { buildInstrumentSessionIdentity, requireSessionSchedule, type BoundInstrument, type SessionScheduleEvidence } from '@ikbr/shared';
export interface PinnedExitSession { sessionDate: string; sessionStart: string; sessionEnd: string; exitDeadline: string; sessionGeneration: number; marginMinutes: number }
export function deriveExitSession(bound: BoundInstrument, evidence: SessionScheduleEvidence | null, attemptedAtMs: number, nowMs: number, marginMinutes: number): PinnedExitSession {
  if (!Number.isInteger(marginMinutes) || marginMinutes < 15 || marginMinutes > 60 || !Number.isFinite(attemptedAtMs) || attemptedAtMs > nowMs) throw new Error('lifecycle_exit_policy_invalid');
  const schedule = requireSessionSchedule(evidence, buildInstrumentSessionIdentity(bound.instrument, bound), nowMs);
  const session = schedule.sessions.find(s => Date.parse(s.start) <= attemptedAtMs && attemptedAtMs < Date.parse(s.end));
  if (!session) throw new Error('lifecycle_original_session_unavailable');
  const deadline = Date.parse(session.end) - marginMinutes * 60000;
  if (deadline <= Date.parse(session.start)) throw new Error('lifecycle_session_too_short');
  return { sessionDate: session.date, sessionStart: session.start, sessionEnd: session.end, exitDeadline: new Date(deadline).toISOString(), sessionGeneration: evidence!.generation, marginMinutes };
}
export function tightenExitSession(pinned: PinnedExitSession, current: PinnedExitSession): PinnedExitSession {
  if (pinned.sessionDate !== current.sessionDate || pinned.sessionStart !== current.sessionStart || pinned.marginMinutes !== current.marginMinutes) throw new Error('lifecycle_session_identity_changed');
  return { ...pinned, sessionEnd: new Date(Math.min(Date.parse(pinned.sessionEnd), Date.parse(current.sessionEnd))).toISOString(), exitDeadline: new Date(Math.min(Date.parse(pinned.exitDeadline), Date.parse(current.exitDeadline))).toISOString(), sessionGeneration: current.sessionGeneration };
}
