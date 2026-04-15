import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional()
);

const schema = z.object({
  EXECUTION_PORT: z.coerce.number().default(3103),
  LOG_LEVEL: z.string().default('info'),
  POSTGRES_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/ikbr_trader'),
  IB_SOCKET_HOST: z.string().default('127.0.0.1'),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  EXECUTION_CLIENT_ID: z.coerce.number().default(102),
  IB_SECURITY_TYPE: z.string().default('STK'),
  IB_EXCHANGE: z.string().default('SMART'),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default('USD'),
  IBKR_ACCOUNT_ID: optionalTrimmedString,
  EXECUTION_DEFAULT_TIF: z.string().default('DAY'),
  EXECUTION_ORDER_TIMEOUT_MS: z.coerce.number().default(15000),
  EXECUTION_DRY_RUN: z.string().default('true')
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  executionDryRun: env.EXECUTION_DRY_RUN.toLowerCase() === 'true'
};
