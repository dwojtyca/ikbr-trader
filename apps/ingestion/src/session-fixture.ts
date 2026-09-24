import { parseBrokerSessionSchedule, type InstrumentSessionIdentity, type SessionScheduleEvidence } from '@ikbr/shared';
export function sessionIdentityFixture(patch: Partial<InstrumentSessionIdentity> = {}): InstrumentSessionIdentity {
  return { instrumentId: 'arbitrary_stock', conId: 1234567, symbol: 'XYZ', secType: 'STK', exchange: 'SMART', currency: 'USD',
    localSymbol: 'XYZ', tradingClass: 'NMS', primaryExchange: 'NASDAQ', useRTH: true, timeZone: 'America/New_York', ...patch };
}
export function sessionEvidenceFixture(identity = sessionIdentityFixture(), now = Date.parse('2026-09-24T18:00:00Z')): SessionScheduleEvidence {
  const dates = ['04', '08', '09', '10', '11', '14', '15', '16', '17', '18', '21', '22', '23', '24'];
  const at = new Date(now).toISOString();
  return { generation: 1, status: 'READY', updatedAt: at, schedule: parseBrokerSessionSchedule({
    startDateTime: '20260904-09:30:00', endDateTime: '20260924-16:00:00', timeZone: identity.timeZone,
    sessions: dates.map(day => ({ refDate: `202609${day}`, startDateTime: `202609${day}-09:30:00`, endDateTime: `202609${day}-16:00:00` })),
  }, identity, at, at) };
}
