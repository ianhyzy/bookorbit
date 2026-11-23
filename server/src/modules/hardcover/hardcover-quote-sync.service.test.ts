import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HardcoverQuoteSyncService } from './hardcover-quote-sync.service';

const quoteRepo = { findPendingPush: vi.fn(), findPendingDelete: vi.fn(), upsertQuoteState: vi.fn(), deleteQuoteState: vi.fn() };
const hardcoverRepo = { findBookState: vi.fn() };
const client = { query: vi.fn() };
const settings = { getSettings: vi.fn(), getTokenForUser: vi.fn() };

const service = () => new HardcoverQuoteSyncService(quoteRepo as any, hardcoverRepo as any, client as any, settings as any);
const highlight = (over: Record<string, unknown> = {}) => ({
  annotationId: 7,
  text: 'a passage',
  version: 3,
  hardcoverReadingJournalId: null,
  ...over,
});
const inserted = (id: number) => ({ insert_reading_journal: { errors: null, reading_journal: { id } } });
const updated = (id: number) => ({ update_reading_journal: { errors: null, reading_journal: { id } } });
const sent = () => client.query.mock.calls.map(([, , mutation, variables]) => ({ mutation: /mutation (\w+)/.exec(mutation)![1], variables }));

describe('HardcoverQuoteSyncService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    settings.getSettings.mockResolvedValue({ effectiveEnabled: true, syncQuotes: true, privacySettingId: 3 });
    settings.getTokenForUser.mockResolvedValue('token');
    hardcoverRepo.findBookState.mockResolvedValue({ hardcoverBookId: 100, hardcoverEditionId: 200, syncOverride: null });
    quoteRepo.findPendingPush.mockResolvedValue([]);
    quoteRepo.findPendingDelete.mockResolvedValue([]);
  });

  it('does nothing when the toggle is off, the book is not linked, or the book is excluded', async () => {
    quoteRepo.findPendingPush.mockResolvedValue([highlight()]);
    settings.getSettings.mockResolvedValueOnce({ effectiveEnabled: true, syncQuotes: false, privacySettingId: 3 });
    await service().syncBookQuotes(1, 5);
    hardcoverRepo.findBookState.mockResolvedValueOnce({ hardcoverBookId: null });
    await service().syncBookQuotes(1, 5);
    hardcoverRepo.findBookState.mockResolvedValueOnce({ hardcoverBookId: 100, syncOverride: 'excluded' });
    await service().syncBookQuotes(1, 5);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('posts a new highlight as a quote on the linked book with the chosen privacy', async () => {
    quoteRepo.findPendingPush.mockResolvedValue([highlight()]);
    client.query.mockResolvedValue(inserted(900));
    await service().syncBookQuotes(1, 5);
    expect(sent()).toEqual([
      {
        mutation: 'InsertReadingJournalEntry',
        variables: { object: { entry: 'a passage', edition_id: 200, privacy_setting_id: 3, book_id: 100, event: 'quote', tags: [] } },
      },
    ]);
    expect(quoteRepo.upsertQuoteState).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationId: 7,
        hardcoverReadingJournalId: 900,
        lastSyncedVersion: 3,
        syncError: null,
      }),
    );
  });

  it('updates the entry in place when a highlight changed', async () => {
    quoteRepo.findPendingPush.mockResolvedValue([highlight({ hardcoverReadingJournalId: 900 })]);
    client.query.mockResolvedValue(updated(900));
    await service().syncBookQuotes(1, 5);
    expect(sent()).toEqual([
      { mutation: 'UpdateReadingJournalEntry', variables: { id: 900, object: { entry: 'a passage', edition_id: 200, privacy_setting_id: 3 } } },
    ]);
  });

  it('deletes the entry for a trashed highlight', async () => {
    quoteRepo.findPendingDelete.mockResolvedValue([{ annotationId: 7, hardcoverReadingJournalId: 900 }]);
    client.query.mockResolvedValue({ delete_reading_journal: { id: 900 } });
    await service().syncBookQuotes(1, 5);
    expect(sent().map((call) => call.variables.id)).toEqual([900]);
    expect(quoteRepo.deleteQuoteState).toHaveBeenCalledWith(1, 7);
  });

  it('records a failure, carries on with the next highlight, and never throws', async () => {
    quoteRepo.findPendingPush.mockResolvedValue([highlight(), highlight({ annotationId: 8 })]);
    client.query.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce(inserted(902));
    await expect(service().syncBookQuotes(1, 5)).resolves.toBeUndefined();
    expect(quoteRepo.upsertQuoteState).toHaveBeenCalledWith(
      expect.objectContaining({ annotationId: 7, lastSyncedVersion: null, syncError: 'rate limited' }),
    );
    expect(quoteRepo.upsertQuoteState).toHaveBeenCalledWith(
      expect.objectContaining({ annotationId: 8, hardcoverReadingJournalId: 902, lastSyncedVersion: 3 }),
    );
  });

  it('reads a full page only once per pass, so rows that keep failing cannot loop forever', async () => {
    const page = Array.from({ length: 25 }, (_, i) => highlight({ annotationId: i + 1 }));
    quoteRepo.findPendingPush.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    client.query.mockRejectedValue(new Error('down'));
    await service().syncBookQuotes(1, 5);
    expect(quoteRepo.findPendingPush.mock.calls.map((call) => call[2])).toEqual([0, 25]);
  });
});
