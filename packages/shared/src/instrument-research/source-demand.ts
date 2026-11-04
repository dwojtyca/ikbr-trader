import { researchHash } from './validation.js';

export type ResearchAdmissionKind = 'regular' | 'demand';
export interface ResearchSourceAcquisition {
  state: 'READY' | 'WAITING' | 'HOLD';
  reason: string;
  nextDemandAt: string | null;
}
export const researchDemandSlotKey = (manifestHash: string, instrumentId: string, sourceId: string, attemptId: string): string =>
  'research_demand_slot_' + researchHash({ manifestHash, instrumentId, sourceId, attemptId });
