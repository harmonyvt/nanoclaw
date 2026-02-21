import { useEffect, useState, useRef } from 'react';
import { api } from '@/api';
import type { Event } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Zap, Play, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

function EventTypeBadge({ type }: { type: string }) {
  const colorClass = type.startsWith('task.')
    ? 'bg-blue-600'
    : type.startsWith('sandbox.')
      ? 'bg-green-600'
      : type.startsWith('session.')
        ? 'bg-purple-600'
        : 'bg-gray-600';

  return <Badge className={cn('font-mono text-xs', colorClass)}>{type}</Badge>;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString();
}

export function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadEvents = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listEvents(100);
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const startStreaming = () => {
    if (streaming) return;

    setStreaming(true);
    unsubscribeRef.current = api.subscribeToEvents(
      (event) => {
        setEvents((prev) => [event, ...prev].slice(0, 500));
      },
      (err) => {
        console.error('Event stream error:', err);
        setStreaming(false);
        setError(err.message);
      },
    );
  };

  const stopStreaming = () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    setStreaming(false);
  };

  useEffect(() => {
    loadEvents();
    return () => {
      stopStreaming();
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Events</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={streaming ? 'destructive' : 'default'}
            size="sm"
            onClick={streaming ? stopStreaming : startStreaming}
          >
            {streaming ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                Stop Stream
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Start Stream
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadEvents}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {streaming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          Live streaming events...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Event Log</CardTitle>
          <Badge variant="secondary">{events.length} events</Badge>
        </CardHeader>
        <CardContent>
          {loading && events.length === 0 ? (
            <div className="space-y-2">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Zap className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No events found</p>
            </div>
          ) : (
            <ScrollArea className="h-[600px]" ref={scrollRef}>
              <div className="space-y-2">
                {events.map((event, index) => (
                  <div
                    key={index}
                    className={cn(
                      'rounded-lg border p-4 transition-colors',
                      index === 0 && streaming && 'bg-muted/50 border-primary',
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <EventTypeBadge type={event.type} />
                        <span className="text-xs text-muted-foreground">
                          {formatDate(event.timestamp)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatTime(event.timestamp)}
                      </span>
                    </div>
                    <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-x-auto">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
