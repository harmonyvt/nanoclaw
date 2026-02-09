import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
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

interface ThreadsPaneProps {
  initialChatJid?: string;
  initialThreadId?: string;
}

export function ThreadsPane({ initialChatJid, initialThreadId }: ThreadsPaneProps) {
  const [threads, setThreads] = useState<ApiThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<ApiThread | null>(null);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatJid, setChatJid] = useState<string | null>(initialChatJid || null);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [manualJid, setManualJid] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async (jid: string) => {
    try {
      const data = await apiFetch<ThreadsResponse>(`/api/threads?chat_jid=${encodeURIComponent(jid)}`);
      setThreads(data.threads);
      setActiveThreadId(data.active_thread_id);
      setError(null);
      return data;
    } catch (err: any) {
      setError(err?.message || 'Failed to load threads');
      return null;
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const data = await apiFetch<MessagesResponse>(
        `/api/threads/messages?thread_id=${encodeURIComponent(threadId)}&limit=200`,
      );
      setMessages(data.messages.reverse());
      setMessageTotal(data.total);
      // Scroll to bottom after render
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err: any) {
      setError(err?.message || 'Failed to load messages');
    }
  }, []);

  // Auto-discover chat_jid on mount
  useEffect(() => {
    async function init() {
      // If we already have a chat_jid (from props/URL), load directly
      if (chatJid) {
        const data = await loadThreads(chatJid);
        if (data && initialThreadId) {
          const thread = data.threads.find(t => t.id === initialThreadId);
          if (thread) {
            setSelectedThread(thread);
            loadMessages(thread.id);
          }
        } else if (data && data.active_thread_id) {
          const active = data.threads.find(t => t.id === data.active_thread_id);
          if (active) {
            setSelectedThread(active);
            loadMessages(active.id);
          }
        }
        setLoading(false);
        return;
      }

      // Auto-discover: find chats that have threads
      try {
        const chats = await apiFetch<string[]>('/api/threads/chats');
        if (chats.length > 0) {
          const jid = chats[0];
          setChatJid(jid);
          const data = await loadThreads(jid);
          if (data && data.active_thread_id) {
            const active = data.threads.find(t => t.id === data.active_thread_id);
            if (active) {
              setSelectedThread(active);
              loadMessages(active.id);
            }
          }
        }
      } catch {
        // No chats with threads found
      }
      setLoading(false);
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      const created = await apiFetch<ApiThread>('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_jid: chatJid, name: newName.trim() }),
      });
      setNewName('');
      await loadThreads(chatJid);
      // Auto-select the new thread
      setSelectedThread({ ...created, is_active: false, message_count: 0 });
      setMessages([]);
      setMessageTotal(0);
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
      if (selectedThread?.id === threadId) {
        setSelectedThread(prev => prev ? { ...prev, name: renameValue.trim() } : null);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to rename thread');
    }
  }, [chatJid, renameValue, loadThreads, selectedThread]);

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

  const handleManualLoad = useCallback(async () => {
    if (!manualJid.trim()) return;
    const jid = manualJid.trim();
    setChatJid(jid);
    setLoading(true);
    await loadThreads(jid);
    setLoading(false);
  }, [manualJid, loadThreads]);

  // No chat_jid: show entry form
  if (!chatJid && !loading) {
    return (
      <div class="pane active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: '400px', padding: '24px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '16px' }}>Conversation Threads</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 16px' }}>
            No threads found. Open this from Telegram with <code>/threads</code> for automatic setup,
            or enter your chat ID below.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={manualJid}
              onInput={(e) => setManualJid((e.target as HTMLInputElement).value)}
              placeholder="tg:123456789"
              style={{
                flex: 1, padding: '8px 12px', background: 'var(--bg-card)',
                border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)',
                fontSize: '13px',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleManualLoad(); }}
            />
            <button
              onClick={handleManualLoad}
              style={{
                padding: '8px 16px', background: 'var(--accent)', border: 'none',
                borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: '13px',
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

  if (error && threads.length === 0) {
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
        width: '260px', minWidth: '260px', borderRight: '1px solid var(--border)',
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
            placeholder="New thread..."
            style={{
              flex: 1, padding: '6px 8px', background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderRadius: '4px',
              color: 'var(--text)', fontSize: '12px',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateThread(); }}
          />
          <button
            onClick={handleCreateThread}
            disabled={!newName.trim()}
            style={{
              padding: '6px 10px', background: newName.trim() ? 'var(--accent)' : 'var(--bg-card)',
              border: newName.trim() ? 'none' : '1px solid var(--border)',
              borderRadius: '4px', color: newName.trim() ? '#fff' : 'var(--text-muted)',
              cursor: newName.trim() ? 'pointer' : 'default', fontSize: '12px',
            }}
          >
            +
          </button>
        </div>

        {error && (
          <div style={{
            padding: '6px 8px', fontSize: '11px', color: 'var(--danger)',
            background: 'rgba(255,59,48,0.1)', borderBottom: '1px solid var(--border)',
          }}>
            {error}
          </div>
        )}

        {/* Thread list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {threads.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              No threads yet. Send a message in Telegram to create one automatically.
            </div>
          ) : (
            threads.map((thread) => {
              const isSelected = selectedThread?.id === thread.id;
              return (
                <div
                  key={thread.id}
                  onClick={() => handleSelectThread(thread)}
                  style={{
                    padding: '10px 12px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                    background: isSelected ? 'var(--bg-card)' : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
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
                        background: 'var(--accent)', color: '#fff', flexShrink: 0,
                      }}>
                        active
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px',
                    display: 'flex', justifyContent: 'space-between',
                  }}>
                    <span>{thread.message_count} msg{thread.message_count !== 1 ? 's' : ''}</span>
                    <span>{timeAgo(thread.updated_at)}</span>
                  </div>
                  <div style={{
                    display: 'flex', gap: '4px', marginTop: '6px', fontSize: '11px',
                  }}>
                    {!thread.is_active && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSwitchThread(thread.id); }}
                        style={{
                          padding: '2px 8px', background: 'var(--accent)', border: 'none',
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
                        padding: '2px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: '3px', color: 'var(--text)', cursor: 'pointer', fontSize: '11px',
                      }}
                    >
                      Rename
                    </button>
                    {threads.length > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(thread.id); }}
                        style={{
                          padding: '2px 8px', background: 'transparent', border: '1px solid var(--danger)',
                          borderRadius: '3px', color: 'var(--danger)', cursor: 'pointer', fontSize: '11px',
                        }}
                      >
                        Del
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Conversation viewer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedThread ? (
          <>
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: 'var(--bg-card)',
            }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '15px' }}>
                  {selectedThread.name}
                </span>
                {selectedThread.is_active && (
                  <span style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                    background: 'var(--accent)', color: '#fff', marginLeft: '8px',
                  }}>
                    active
                  </span>
                )}
              </div>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {messageTotal} message{messageTotal !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={{
              flex: 1, overflowY: 'auto', padding: '16px',
              display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              {messages.length === 0 ? (
                <div style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-muted)', fontSize: '13px',
                }}>
                  No messages in this thread yet
                </div>
              ) : (
                <>
                  {messageTotal > messages.length && (
                    <div style={{
                      textAlign: 'center', padding: '8px', fontSize: '11px',
                      color: 'var(--text-muted)',
                    }}>
                      Showing {messages.length} of {messageTotal} messages
                    </div>
                  )}
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: '8px', color: 'var(--text-muted)',
          }}>
            <span style={{ fontSize: '24px', opacity: 0.5 }}>&#128172;</span>
            <span style={{ fontSize: '14px' }}>Select a thread to view the conversation</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ApiMessage }) {
  // Simple heuristic: messages starting with [ are system/bot messages
  const isSystem = msg.content.startsWith('[');
  const time = new Date(msg.timestamp);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <div style={{
      padding: '8px 12px',
      background: 'var(--bg-card)',
      borderRadius: '8px',
      border: '1px solid var(--border)',
      maxWidth: '100%',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '4px',
      }}>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: isSystem ? 'var(--text-muted)' : 'var(--accent)',
        }}>
          {msg.sender_name}
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {dateStr} {timeStr}
        </span>
      </div>
      <div style={{
        fontSize: '13px', lineHeight: '1.45', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {truncate(msg.content, 2000)}
      </div>
      {msg.media_type && (
        <div style={{
          fontSize: '11px', color: 'var(--accent)', marginTop: '4px',
          fontStyle: 'italic',
        }}>
          Attachment: {msg.media_type}
        </div>
      )}
    </div>
  );
}
