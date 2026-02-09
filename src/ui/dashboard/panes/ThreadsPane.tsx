import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, truncate } from '../../shared/hooks.js';

interface ApiThread {
  id: string;
  chat_jid: string;
  name: string;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  is_active: boolean;
  message_count: number;
}

interface ApiMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  media_type?: string;
  media_path?: string;
  thread_id?: string;
}

interface ThreadsResponse {
  threads: ApiThread[];
  active_thread_id: string | null;
}

interface MessagesResponse {
  messages: ApiMessage[];
  total: number;
}

export function ThreadsPane() {
  const [threads, setThreads] = useState<ApiThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<ApiThread | null>(null);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatJid, setChatJid] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Discover chat_jid from groups
  useEffect(() => {
    apiFetch<{ name: string; folder: string }[]>('/api/files/groups')
      .then((groups) => {
        // Look for main group's chat_jid by loading threads for common patterns
        // The simplest approach: try loading from registered groups data
        // We need to find the chat_jid. Since we don't have direct access,
        // use the fact that groups with threads will have data.
        // Fall back to trying the TELEGRAM_OWNER_ID pattern.
        if (groups.length > 0) {
          // Try to find threads for each potential chat
          // The dashboard doesn't directly know chat_jids, so we'll use
          // a dedicated endpoint or iterate.
          // For now, try the owner ID approach: tg:<owner_id>
          tryFindChatJid(groups);
        }
      })
      .catch(() => setError('Failed to load groups'));
  }, []);

  async function tryFindChatJid(groups: { name: string; folder: string }[]) {
    // Try each group folder to find one with threads
    for (const group of groups) {
      try {
        // We'll use a search approach - try common jid patterns
        // First, check if threads exist for any chat
        const data = await apiFetch<ThreadsResponse>(
          `/api/threads?chat_jid=tg:discover:${group.folder}`,
        );
        if (data.threads.length > 0) {
          setChatJid(`tg:discover:${group.folder}`);
          setThreads(data.threads);
          setActiveThreadId(data.active_thread_id);
          setLoading(false);
          return;
        }
      } catch {
        // continue
      }
    }
    // If no threads found anywhere, that's OK
    setLoading(false);
  }

  const loadThreads = useCallback(async (jid: string) => {
    try {
      const data = await apiFetch<ThreadsResponse>(`/api/threads?chat_jid=${encodeURIComponent(jid)}`);
      setThreads(data.threads);
      setActiveThreadId(data.active_thread_id);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load threads');
    }
  }, []);

  // Provide a way to manually enter chat_jid
  const [manualJid, setManualJid] = useState('');

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const data = await apiFetch<MessagesResponse>(
        `/api/threads/messages?thread_id=${encodeURIComponent(threadId)}&limit=100`,
      );
      // Messages come in DESC order from API, reverse for display
      setMessages(data.messages.reverse());
      setMessageTotal(data.total);
    } catch (err: any) {
      setError(err?.message || 'Failed to load messages');
    }
  }, []);

  const handleSelectThread = useCallback((thread: ApiThread) => {
    setSelectedThread(thread);
    loadMessages(thread.id);
  }, [loadMessages]);

  const handleSwitchThread = useCallback(async (threadId: string) => {
    if (!chatJid) return;
    try {
      await apiFetch('/api/threads/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_jid: chatJid, thread_id: threadId }),
      });
      setActiveThreadId(threadId);
      await loadThreads(chatJid);
    } catch (err: any) {
      setError(err?.message || 'Failed to switch thread');
    }
  }, [chatJid, loadThreads]);

  const handleCreateThread = useCallback(async () => {
    if (!chatJid || !newName.trim()) return;
    try {
      await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_jid: chatJid, name: newName.trim() }),
      });
      setNewName('');
      await loadThreads(chatJid);
    } catch (err: any) {
      setError(err?.message || 'Failed to create thread');
    }
  }, [chatJid, newName, loadThreads]);

  const handleRename = useCallback(async (threadId: string) => {
    if (!renameValue.trim()) return;
    try {
      await apiFetch('/api/threads/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, name: renameValue.trim() }),
      });
      setRenamingId(null);
      setRenameValue('');
      if (chatJid) await loadThreads(chatJid);
    } catch (err: any) {
      setError(err?.message || 'Failed to rename thread');
    }
  }, [chatJid, renameValue, loadThreads]);

  const handleDelete = useCallback(async (threadId: string) => {
    if (!chatJid) return;
    try {
      await apiFetch('/api/threads/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_jid: chatJid, thread_id: threadId }),
      });
      if (selectedThread?.id === threadId) {
        setSelectedThread(null);
        setMessages([]);
      }
      await loadThreads(chatJid);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete thread');
    }
  }, [chatJid, selectedThread, loadThreads]);

  // If no chat_jid found automatically, let user enter one
  if (!chatJid && !loading) {
    return (
      <div class="pane active">
        <div style={{ padding: '16px' }}>
          <p>Enter your Telegram chat JID to view threads (e.g., <code>tg:123456789</code>):</p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <input
              type="text"
              value={manualJid}
              onInput={(e) => setManualJid((e.target as HTMLInputElement).value)}
              placeholder="tg:123456789"
              style={{
                flex: 1, padding: '6px 10px', background: 'var(--bg-card)',
                border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualJid.trim()) {
                  setChatJid(manualJid.trim());
                  setLoading(true);
                  loadThreads(manualJid.trim()).then(() => setLoading(false));
                }
              }}
            />
            <button
              onClick={() => {
                if (manualJid.trim()) {
                  setChatJid(manualJid.trim());
                  setLoading(true);
                  loadThreads(manualJid.trim()).then(() => setLoading(false));
                }
              }}
              style={{
                padding: '6px 16px', background: 'var(--accent)', border: 'none',
                borderRadius: '4px', color: '#fff', cursor: 'pointer',
              }}
            >
              Load
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading threads...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="pane active">
        <div class="empty">{error}</div>
      </div>
    );
  }

  return (
    <div class="pane active" style={{ display: 'flex', height: '100%' }}>
      {/* Thread list sidebar */}
      <div style={{
        width: '280px', minWidth: '280px', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* New thread input */}
        <div style={{
          padding: '8px', borderBottom: '1px solid var(--border)',
          display: 'flex', gap: '4px',
        }}>
          <input
            type="text"
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
            placeholder="New thread name..."
            style={{
              flex: 1, padding: '4px 8px', background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderRadius: '4px',
              color: 'var(--text)', fontSize: '12px',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateThread(); }}
          />
          <button
            onClick={handleCreateThread}
            disabled={!newName.trim()}
            style={{
              padding: '4px 8px', background: 'var(--accent)', border: 'none',
              borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px',
            }}
          >
            +
          </button>
        </div>

        {/* Thread list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {threads.length === 0 ? (
            <div class="empty" style={{ padding: '16px', fontSize: '13px' }}>
              No threads yet. Send a message to create one.
            </div>
          ) : (
            threads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => handleSelectThread(thread)}
                style={{
                  padding: '10px 12px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border)',
                  background: selectedThread?.id === thread.id ? 'var(--bg-card)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {renamingId === thread.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(thread.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      autoFocus
                      style={{
                        flex: 1, padding: '2px 4px', background: 'var(--bg-card)',
                        border: '1px solid var(--accent)', borderRadius: '2px',
                        color: 'var(--text)', fontSize: '13px',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>
                      {thread.name}
                    </span>
                  )}
                  {thread.is_active && (
                    <span style={{
                      fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                      background: 'var(--accent)', color: '#fff',
                    }}>
                      active
                    </span>
                  )}
                </div>
                <div style={{
                  fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px',
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span>{thread.message_count} msgs</span>
                  <span>{timeAgo(thread.updated_at)}</span>
                </div>
                <div style={{
                  display: 'flex', gap: '4px', marginTop: '6px', fontSize: '11px',
                }}>
                  {!thread.is_active && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSwitchThread(thread.id); }}
                      style={{
                        padding: '2px 6px', background: 'var(--accent)', border: 'none',
                        borderRadius: '3px', color: '#fff', cursor: 'pointer', fontSize: '11px',
                      }}
                    >
                      Activate
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(thread.id);
                      setRenameValue(thread.name);
                    }}
                    style={{
                      padding: '2px 6px', background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: '3px', color: 'var(--text)', cursor: 'pointer', fontSize: '11px',
                    }}
                  >
                    Rename
                  </button>
                  {threads.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(thread.id); }}
                      style={{
                        padding: '2px 6px', background: 'transparent', border: '1px solid var(--danger)',
                        borderRadius: '3px', color: 'var(--danger)', cursor: 'pointer', fontSize: '11px',
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Message viewer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedThread ? (
          <>
            <div style={{
              padding: '8px 12px', borderBottom: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontWeight: 600, fontSize: '14px' }}>
                {selectedThread.name}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {messageTotal} message{messageTotal !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={{
              flex: 1, overflowY: 'auto', padding: '12px',
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}>
              {messages.length === 0 ? (
                <div class="empty" style={{ marginTop: '32px' }}>No messages in this thread</div>
              ) : (
                messages.map((msg) => {
                  const isBot = msg.sender_name?.includes('Bot') || msg.content.startsWith('[');
                  return (
                    <div
                      key={msg.id}
                      style={{
                        padding: '8px 12px',
                        background: isBot ? 'var(--bg-card)' : 'transparent',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        marginBottom: '4px', fontSize: '11px', color: 'var(--text-muted)',
                      }}>
                        <span style={{ fontWeight: 600 }}>{msg.sender_name}</span>
                        <span>{timeAgo(msg.timestamp)}</span>
                      </div>
                      <div style={{
                        fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {truncate(msg.content, 500)}
                      </div>
                      {msg.media_type && (
                        <div style={{
                          fontSize: '11px', color: 'var(--accent)', marginTop: '4px',
                        }}>
                          [{msg.media_type}]
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <div class="empty" style={{ marginTop: '32px' }}>
            Select a thread to view its conversation
          </div>
        )}
      </div>
    </div>
  );
}
