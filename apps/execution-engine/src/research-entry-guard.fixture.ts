import { ExecutionRepository } from './repository.js';

/** Existing PP1–PP3 isolated suites test their original guard contracts with the
 * independently tested PP4 port stubbed. Production never imports this fixture. */
export class LegacyResearchCompatibilityRepository extends ExecutionRepository {
  constructor(...args: ConstructorParameters<typeof ExecutionRepository>) {
    super(args[0], args[1], args[2], args[3], args[4], args[5], async () => ({
      validUntilMs: Number.MAX_SAFE_INTEGER, assertCurrent: () => {},
    }));
  }
}
