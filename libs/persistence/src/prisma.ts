import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };

/** A client that can run queries: the root client or a transaction handle. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** A Prisma client on a given connection URL (the app role's for services, the owner's for the bootstrap). */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url, log: ['warn', 'error'] });
}
