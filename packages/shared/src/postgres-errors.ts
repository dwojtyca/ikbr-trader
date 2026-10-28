interface ErrorSource {
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface PoolErrorSource extends ErrorSource {
  on(event: 'connect', listener: (client: ErrorSource) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const failedClients = new WeakMap<object, Error>();
const observedPools = new WeakSet<object>();

/** pg-pool removes its idle error listener while a client is checked out. */
export function observePostgresPoolErrors(pool: PoolErrorSource, report: (error: Error) => void): void {
  if (observedPools.has(pool)) return;
  observedPools.add(pool);
  const reported = new WeakSet<Error>();
  const reportOnce = (error: Error) => {
    if (reported.has(error)) return;
    reported.add(error);
    report(error);
  };
  pool.on('error', reportOnce);
  pool.on('connect', client => {
    client.on('error', error => {
      if (!failedClients.has(client)) failedClients.set(client, error);
      reportOnce(error);
    });
  });
}

/** Final synchronous send guards must also reject a known failed transaction connection. */
export function assertPostgresClientUsable(client: object): void {
  const error = failedClients.get(client);
  if (error) throw error;
}
