import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { NewHardcoverQuoteState } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

export interface PendingQuotePush {
  annotationId: number;
  text: string;
  version: number;
  hardcoverReadingJournalId: number | null;
}

export interface PendingQuoteDelete {
  annotationId: number;
  hardcoverReadingJournalId: number | null;
}

@Injectable()
export class HardcoverQuoteRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsertQuoteState(data: NewHardcoverQuoteState): Promise<void> {
    await this.db
      .insert(schema.hardcoverQuoteState)
      .values(data)
      .onConflictDoUpdate({ target: schema.hardcoverQuoteState.annotationId, set: { ...data, updatedAt: new Date() } });
  }

  async deleteQuoteState(userId: number, annotationId: number): Promise<void> {
    await this.db
      .delete(schema.hardcoverQuoteState)
      .where(and(eq(schema.hardcoverQuoteState.userId, userId), eq(schema.hardcoverQuoteState.annotationId, annotationId)));
  }

  /** Live highlights that are new, changed since the last push, or failed last time. Keyset-paged by annotation id. */
  async findPendingPush(userId: number, bookId: number, afterAnnotationId: number, limit: number): Promise<PendingQuotePush[]> {
    return this.db
      .select({
        annotationId: schema.annotations.id,
        text: schema.annotations.text,
        version: schema.annotations.version,
        hardcoverReadingJournalId: schema.hardcoverQuoteState.hardcoverReadingJournalId,
      })
      .from(schema.annotations)
      .leftJoin(schema.hardcoverQuoteState, eq(schema.hardcoverQuoteState.annotationId, schema.annotations.id))
      .where(
        and(
          eq(schema.annotations.userId, userId),
          eq(schema.annotations.bookId, bookId),
          gt(schema.annotations.id, afterAnnotationId),
          isNull(schema.annotations.deletedAt),
          ne(schema.annotations.text, ''),
          or(isNull(schema.hardcoverQuoteState.lastSyncedVersion), lt(schema.hardcoverQuoteState.lastSyncedVersion, schema.annotations.version)),
        ),
      )
      .orderBy(schema.annotations.id)
      .limit(limit);
  }

  /** Trashed highlights that still have an entry on Hardcover. */
  async findPendingDelete(userId: number, bookId: number, afterAnnotationId: number, limit: number): Promise<PendingQuoteDelete[]> {
    return this.db
      .select({
        annotationId: schema.annotations.id,
        hardcoverReadingJournalId: schema.hardcoverQuoteState.hardcoverReadingJournalId,
      })
      .from(schema.annotations)
      .innerJoin(schema.hardcoverQuoteState, eq(schema.hardcoverQuoteState.annotationId, schema.annotations.id))
      .where(
        and(
          eq(schema.annotations.userId, userId),
          eq(schema.annotations.bookId, bookId),
          gt(schema.annotations.id, afterAnnotationId),
          isNotNull(schema.annotations.deletedAt),
        ),
      )
      .orderBy(schema.annotations.id)
      .limit(limit);
  }
}
