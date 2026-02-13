import { useState, useEffect, useRef } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, truncate } from '../../shared/hooks.js';

interface ChatEntry {
  jid: string;
  name: string;
  last_message_time: string;
  message_count: number;
}

interface ChatMessage {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  media_type: string | null;
  media_path: string | null;
  is_reset: boolean;
}

function ChatList({ onSelect }: { onSelect: (chat: ChatEntry) => void }) {
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<ChatEntry[]>('/api/chats')
      .then((data) => {
        setChats(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load chats');
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading chats...</div>
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

  if (chats.length === 0) {
    return (
      <div class="pane active">
        <div class="empty">No chats yet</div>
      </div>
    );
  }

  return (
    <div class="pane active">
      <div class="card-list">
        {chats.map((chat) => (
          <div
            class="card"
            key={chat.jid}
            onClick={() => onSelect(chat)}
          >
            <div class="card-header">
              <span class="card-title">{chat.name || chat.jid}</span>
              <span class="chat-count">
                {chat.message_count} msg{chat.message_count !== 1 ? 's' : ''}
              </span>
            </div>
            <div class="card-meta">
              {chat.last_message_time
                ? timeAgo(chat.last_message_time)
                : 'No messages'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatDate(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function ChatDetail({
  chatJid,
  chatName,
  onBack,
}: {
  chatJid: string;
  chatName: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<ChatMessage[]>(
      `/api/chats/messages?jid=${encodeURIComponent(chatJid)}`,
    )
      .then((data) => {
        setMessages(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load messages');
        setLoading(false);
      });
  }, [chatJid]);

  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [loading, messages]);

  return (
    <div class="pane active" style={{ flexDirection: 'column' }}>
      <div class="chat-header">
        <button class="chat-back" onClick={onBack}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <span class="chat-header-title">{chatName}</span>
        <span class="chat-header-meta">
          {messages.filter((m) => !m.is_reset).length} messages
        </span>
      </div>

      {loading ? (
        <div class="loading">Loading messages...</div>
      ) : error ? (
        <div class="empty">{error}</div>
      ) : messages.length === 0 ? (
        <div class="empty">No messages in this chat</div>
      ) : (
        <div class="chat-messages" ref={scrollRef}>
          {messages.map((msg, i) => {
            if (msg.is_reset) {
              return (
                <div class="chat-thread-divider" key={msg.id}>
                  New conversation
                </div>
              );
            }

            // Insert date separator when date changes
            const prevMsg = i > 0 ? messages[i - 1] : null;
            const showDate =
              !prevMsg ||
              prevMsg.is_reset ||
              formatDate(msg.timestamp) !== formatDate(prevMsg.timestamp);

            const isBot = msg.is_from_me === 1;
            const msgClass = isBot ? 'chat-msg chat-msg-bot' : 'chat-msg chat-msg-user';

            return (
              <div key={msg.id}>
                {showDate && (
                  <div class="chat-date-divider">{formatDate(msg.timestamp)}</div>
                )}
                <div class={msgClass}>
                  <div class="chat-msg-sender">
                    {msg.sender_name || msg.sender}
                  </div>
                  <div class="chat-msg-content">
                    {truncate(msg.content, 2000)}
                  </div>
                  {msg.media_type && (
                    <div class="chat-msg-media">
                      [{msg.media_type}]
                    </div>
                  )}
                  <div class="chat-msg-time">{formatTime(msg.timestamp)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChatsPane() {
  const [selectedChat, setSelectedChat] = useState<{
    jid: string;
    name: string;
  } | null>(null);

  if (selectedChat) {
    return (
      <ChatDetail
        chatJid={selectedChat.jid}
        chatName={selectedChat.name}
        onBack={() => setSelectedChat(null)}
      />
    );
  }

  return (
    <ChatList
      onSelect={(chat) =>
        setSelectedChat({ jid: chat.jid, name: chat.name || chat.jid })
      }
    />
  );
}
