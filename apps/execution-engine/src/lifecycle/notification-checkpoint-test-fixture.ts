import type { BrokerReconciliationSnapshot } from '../reconciliation/broker-adapter.js';
export function flatNotificationSnapshot(accountId='PAPER',sessionId='session',generation=1):BrokerReconciliationSnapshot {
  const now=new Date(), source={available:true,boundedWindow:true,timedOut:false,count:0};
  return {accountId,sessionId,connectionGeneration:generation,capturedAt:now,originalAcquisitionStartedAt:now.toISOString(),exposureComplete:true,recoveryComplete:true,
    positions:[],openOrders:[],executions:[],completedOrders:[],sourceCoverage:{positions:{...source},openOrders:{...source},completedOrders:{...source},session:{...source,count:1},
      executions:{available:true,timedOut:false,count:0,window:{from:now.toISOString(),to:now.toISOString(),exposureWindowComplete:true,recoveryWindowComplete:true}}}};
}
