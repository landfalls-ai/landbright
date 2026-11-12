import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma, PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';

/** The tenant's database: every read and write runs in a transaction that row-level security scopes to the tenant. */
@Injectable()
export class TenantDb {
  constructor(
    @Inject(PRISMA) readonly prisma: PrismaClient,
    @Inject(TENANT) readonly tenant: TenantRef,
  ) {}

  get tenantId(): string {
    return this.tenant.id;
  }

  tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, this.tenant.id, fn);
  }
}

/** Turns a unique-constraint violation into a 409 with a sentence the console can show. */
export async function uniquely<T>(work: Promise<T>, message: string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ConflictException(message);
    throw error;
  }
}

/** `2026-11-12` from a date column. */
export const isoDate = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const toDate = (s: string | null | undefined): Date | null | undefined =>
  s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00Z`);
