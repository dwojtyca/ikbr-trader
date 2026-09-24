import { parseBrokerAaplSchedule, type AaplScheduleEvidence } from "@ikbr/shared";
export function scheduleFixture(now = Date.parse('2026-09-24T18:00:00Z')): AaplScheduleEvidence {
  const dates = ['04', '08', '09', '10', '11', '14', '15', '16', '17', '18', '21', '22', '23', '24'];
  const at = new Date(now).toISOString();
  return { generation: 1, status: 'READY', updatedAt: at, schedule: parseBrokerAaplSchedule({
    startDateTime: '20260904-09:30:00', endDateTime: '20260924-16:00:00', timeZone: 'US/Eastern',
    sessions: dates.map(day => ({ refDate: `202609${day}`, startDateTime: `202609${day}-09:30:00`, endDateTime: `202609${day}-16:00:00` })),
  }, at, at) };
}
