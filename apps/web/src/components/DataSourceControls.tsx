/**
 * Connect / sync / upload controls for the athlete's data sources.
 *
 * This lived inside CalendarTab, which meant a 627-line month-grid component
 * also owned the app's only Wahoo integration surface: connection state, a
 * 3-second sync poll, the sync handler and the .fit upload. None of that is
 * about rendering a calendar — CalendarTab only needs to know that the data
 * changed so it can reload the month, which is what `onDataChanged` is for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { getJson, postJson } from '@/lib/api';
import type { HealthStatus, WahooStatus, WahooSyncStarted } from '@/lib/api-types';

/** How often to re-check while a sync is running. */
const SYNC_POLL_MS = 3000;

export function DataSourceControls({ onDataChanged }: { onDataChanged: () => void | Promise<void> }) {
  const [wahoo, setWahoo] = useState<WahooStatus | null>(null);
  // null = not yet known. The Connect button stays hidden until this answers,
  // which is the right default: offering a dead link is worse than a late one.
  const [wahooAvailable, setWahooAvailable] = useState<boolean | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Two different questions. /api/health says whether the integration exists
    // at all — in chat-only mode its routes are never mounted — and /status says
    // whether this athlete has linked their account. Treating a failed /status
    // as merely "not connected" is what put a Connect button in front of a route
    // that answers 404.
    getJson<HealthStatus>('/api/health')
      .then((h) => setWahooAvailable(h.wahoo))
      .catch(() => setWahooAvailable(false));

    getJson<WahooStatus>('/api/wahoo/status').then(setWahoo).catch(() => {});
  }, []);

  // Poll only while a sync is in flight, and tell the parent once it settles so
  // it can pick up whatever the sync imported.
  useEffect(() => {
    if (wahoo?.syncStatus !== 'syncing') return;
    const timer = setInterval(async () => {
      // A failed poll keeps the previous state and tries again next tick,
      // rather than flipping the UI out of "syncing" on a blip.
      const next = await getJson<WahooStatus>('/api/wahoo/status').catch(() => null);
      if (!next) return;
      setWahoo(next);
      if (next.syncStatus !== 'syncing') await onDataChanged();
    }, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [wahoo?.syncStatus, onDataChanged]);

  const handleSync = useCallback(async () => {
    try {
      const body = await postJson<WahooSyncStarted>('/api/wahoo/sync');
      // The BFF reports queued:false when a sync is already in flight.
      if (body?.queued === false) {
        alert(body.message || 'A sync is already running.');
        return;
      }
      setWahoo((s) => (s ? { ...s, syncStatus: 'syncing' } : s));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Sync failed — check your connection.');
    }
  }, []);

  const handleImportFit = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      setImporting(true);
      try {
        await postJson(`/api/activities/import-fit?filename=${encodeURIComponent(file.name)}`, {
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        await onDataChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Import failed — check your connection.');
      } finally {
        setImporting(false);
      }
    },
    [onDataChanged],
  );

  const syncing = wahoo?.syncStatus === 'syncing';
  const failed = wahoo?.syncStatus === 'failed';

  return (
    <div className="flex items-center gap-2">
      <input ref={fileInputRef} type="file" accept=".fit" className="hidden" onChange={handleImportFit} />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="Import a .fit file"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="h-8 w-8"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Import a .fit file</TooltipContent>
      </Tooltip>

      {wahoo?.connected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label={syncing ? 'Syncing' : 'Sync from Wahoo'}
              onClick={handleSync}
              disabled={syncing}
              className="h-8 w-8"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''} ${failed ? 'text-destructive' : ''}`}
              />
            </Button>
          </TooltipTrigger>
          {/* A background sync that dies only stops the spinner, which looks
              identical to finishing — so the failure has to be said out loud. */}
          <TooltipContent>
            {syncing
              ? 'Syncing…'
              : failed
                ? `Last sync failed: ${wahoo.lastSyncError ?? 'unknown error'}`
                : 'Sync from Wahoo'}
          </TooltipContent>
        </Tooltip>
      )}

      {wahooAvailable === true && !wahoo?.connected && (
        <Button
          size="sm"
          onClick={() => {
            window.location.href = '/api/wahoo/connect';
          }}
        >
          Connect
        </Button>
      )}
    </div>
  );
}
