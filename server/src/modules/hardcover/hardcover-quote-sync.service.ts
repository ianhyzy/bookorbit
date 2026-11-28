import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverQuoteRepository, type PendingQuoteDelete, type PendingQuotePush } from './hardcover-quote.repository';
import { HardcoverSettingsService } from './hardcover-settings.service';
import { normalizeHardcoverBookSyncOverride } from './hardcover-sync-policy';
import { HardcoverRepository } from './hardcover.repository';

// Fork addition, after Dukko's proposal in bookorbit/bookorbit#1011: Hardcover has no quotes API, a
// quote is a reading_journals row with event "quote". A highlight's own note is not sent: Hardcover
// accepts a "note" row but its site never shows one, and a quote row has no field for a comment.

const SYNC_EVENT = 'hardcover.sync_quotes';
const BATCH_SIZE = 25;
const MAX_ENTRY_LENGTH = 8191;

const INSERT_MUTATION = `
mutation InsertReadingJournalEntry($object: ReadingJournalCreateType!) {
  insert_reading_journal(object: $object) {
    errors
    reading_journal {
      id
    }
  }
}`;

const UPDATE_MUTATION = `
mutation UpdateReadingJournalEntry($id: Int!, $object: ReadingJournalUpdateType!) {
  update_reading_journal(id: $id, object: $object) {
    errors
    reading_journal {
      id
    }
  }
}`;

const DELETE_MUTATION = `
mutation DeleteReadingJournalEntry($id: Int!) {
  delete_reading_journal(id: $id) {
    id
  }
}`;

type InsertResult = { insert_reading_journal: { errors: string[] | null; reading_journal: { id: number } | null } };
type UpdateResult = { update_reading_journal: { errors: string[] | null; reading_journal: { id: number } | null } };

interface Target {
  userId: number;
  bookId: number;
  token: string;
  hardcoverBookId: number;
  hardcoverEditionId: number | null;
  privacySettingId: number;
}

@Injectable()
export class HardcoverQuoteSyncService {
  private readonly logger = new Logger(HardcoverQuoteSyncService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly quoteRepo: HardcoverQuoteRepository,
    private readonly hardcoverRepo: HardcoverRepository,
    private readonly client: HardcoverClientService,
    private readonly settingsService: HardcoverSettingsService,
  ) {}

  /** Never throws: it runs after the status sync and must not turn a good sync into a failed one. */
  async syncBookQuotes(userId: number, bookId: number): Promise<void> {
    const key = `${userId}:${bookId}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    const startedAt = Date.now();
    let pushed = 0;
    let deleted = 0;
    let failed = 0;

    try {
      const settings = await this.settingsService.getSettings(userId);
      if (!settings.effectiveEnabled || !settings.syncQuotes) return;
      const token = await this.settingsService.getTokenForUser(userId);
      if (!token) return;
      // Only books the status sync has already linked, and never one the user excluded.
      const state = await this.hardcoverRepo.findBookState(userId, bookId);
      if (!state?.hardcoverBookId || normalizeHardcoverBookSyncOverride(state) === 'excluded') return;

      const target: Target = {
        userId,
        bookId,
        token,
        hardcoverBookId: state.hardcoverBookId,
        hardcoverEditionId: state.hardcoverEditionId ?? null,
        privacySettingId: settings.privacySettingId,
      };

      for (let after = 0; ;) {
        const rows = await this.quoteRepo.findPendingDelete(userId, bookId, after, BATCH_SIZE);
        for (const row of rows) {
          if (await this.removeEntries(target, row)) deleted++;
          else failed++;
        }
        if (rows.length < BATCH_SIZE) break;
        after = rows[rows.length - 1].annotationId;
      }
      for (let after = 0; ;) {
        const rows = await this.quoteRepo.findPendingPush(userId, bookId, after, BATCH_SIZE);
        for (const row of rows) {
          if (await this.pushHighlight(target, row)) pushed++;
          else failed++;
        }
        if (rows.length < BATCH_SIZE) break;
        after = rows[rows.length - 1].annotationId;
      }

      if (pushed || deleted || failed) {
        this.logger.log(
          `[${SYNC_EVENT}] [end] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAt} pushed=${pushed} deleted=${deleted} failed=${failed} - quote sync completed`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[${SYNC_EVENT}] [fail] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${error}" - quote sync crashed`,
      );
    } finally {
      this.running.delete(key);
    }
  }

  private async pushHighlight(target: Target, row: PendingQuotePush): Promise<boolean> {
    try {
      const quoteId = await this.upsertEntry(target, row.hardcoverReadingJournalId, row.text.slice(0, MAX_ENTRY_LENGTH));
      await this.saveState(target, row.annotationId, quoteId, row.version, null);
      return true;
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[${SYNC_EVENT}] [fail] userId=${target.userId} bookId=${target.bookId} annotationId=${row.annotationId} error="${error}" - quote push failed`,
      );
      await this.saveState(target, row.annotationId, row.hardcoverReadingJournalId, null, error);
      return false;
    }
  }

  private async removeEntries(target: Target, row: PendingQuoteDelete): Promise<boolean> {
    try {
      if (row.hardcoverReadingJournalId != null) {
        await this.client.query(target.userId, target.token, DELETE_MUTATION, { id: row.hardcoverReadingJournalId });
      }
      await this.quoteRepo.deleteQuoteState(target.userId, row.annotationId);
      return true;
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[${SYNC_EVENT}] [fail] userId=${target.userId} annotationId=${row.annotationId} error="${error}" - quote delete failed`);
      return false;
    }
  }

  private async upsertEntry(target: Target, existingId: number | null, entry: string): Promise<number> {
    const shared = {
      entry,
      ...(target.hardcoverEditionId != null && { edition_id: target.hardcoverEditionId }),
      privacy_setting_id: target.privacySettingId,
    };
    if (existingId != null) {
      const result = await this.client.query<UpdateResult>(target.userId, target.token, UPDATE_MUTATION, { id: existingId, object: shared });
      if (result.update_reading_journal.errors?.length) throw new Error(result.update_reading_journal.errors.join(', '));
      return result.update_reading_journal.reading_journal?.id ?? existingId;
    }
    // Create needs book_id and a non-null tags list; update accepts neither.
    const result = await this.client.query<InsertResult>(target.userId, target.token, INSERT_MUTATION, {
      object: { ...shared, book_id: target.hardcoverBookId, event: 'quote', tags: [] },
    });
    if (result.insert_reading_journal.errors?.length) throw new Error(result.insert_reading_journal.errors.join(', '));
    const id = result.insert_reading_journal.reading_journal?.id;
    if (id == null) throw new Error('insert_reading_journal returned no id');
    return id;
  }

  private saveState(target: Target, annotationId: number, quoteId: number | null, version: number | null, error: string | null) {
    return this.quoteRepo.upsertQuoteState({
      userId: target.userId,
      bookId: target.bookId,
      annotationId,
      hardcoverReadingJournalId: quoteId,
      lastSyncedVersion: version,
      lastSyncedAt: version == null ? undefined : new Date(),
      syncError: error,
    });
  }
}
