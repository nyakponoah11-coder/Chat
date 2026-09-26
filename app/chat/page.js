'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, getSession, clearSession, getPrivateKeyJwk, setPrivateKeyJwk } from '../../lib/supabase';
import {
  importPrivateKeyJwk, generateChannelKey, wrapChannelKeyForMember, unwrapChannelKey,
  encryptMessage, decryptMessage, deriveKeyFromPassword, decryptPrivateKey,
} from '../../lib/crypto';
import CallPanel from '../../components/CallPanel';

export default function ChatPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [privateKey, setPrivateKey] = useState(null); // CryptoKey, unwrapped in memory
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');

  const [tab, setTab] = useState('chats');
  const [myChannels, setMyChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [channelKeys, setChannelKeys] = useState({}); // channelId -> CryptoKey
  const [messages, setMessages] = useState([]); // decrypted, in-memory only
  const [text, setText] = useState('');
  const [usersMap, setUsersMap] = useState({}); // id -> {name, avatar_color, public_key}
  const [otherUsers, setOtherUsers] = useState([]);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [picked, setPicked] = useState([]);
  const [newChannelName, setNewChannelName] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [statusText, setStatusText] = useState('');
  const [call, setCall] = useState(null);
  const [about, setAbout] = useState('');
  const scrollRef = useRef(null);

  // ---- Boot: load session, and either use the cached private key or ask to unlock ----
  useEffect(() => {
    const s = getSession();
    if (!s) { router.push('/'); return; }
    setMe(s);
    setAbout(s.about || '');
    const cachedJwk = getPrivateKeyJwk();
    if (cachedJwk) {
      importPrivateKeyJwk(cachedJwk).then(setPrivateKey);
    } else {
      setNeedsUnlock(true);
    }
  }, [router]);

  async function handleUnlock(e) {
    e.preventDefault();
    setUnlockError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: me.name, password: unlockPassword }),
      });
      const data = await res.json();
      if (!res.ok) { setUnlockError('Incorrect password.'); return; }
      const passwordKey = await deriveKeyFromPassword(unlockPassword, data.user.salt);
      const { ciphertext, iv } = JSON.parse(data.user.encrypted_private_key);
      const jwk = await decryptPrivateKey(ciphertext, iv, passwordKey);
      setPrivateKeyJwk(jwk);
      setPrivateKey(await importPrivateKeyJwk(jwk));
      setNeedsUnlock(false);
    } catch {
      setUnlockError('Incorrect password.');
    }
  }

  useEffect(() => {
    if (!me || !privateKey) return;
    loadUsers();
    loadChannels();
    loadStatuses();
  }, [me, privateKey]);

  async function loadUsers() {
    const { data } = await supabase.from('public_users').select('*');
    const map = {};
    (data || []).forEach((u) => { map[u.id] = u; });
    setUsersMap(map);
    setOtherUsers((data || []).filter((u) => u.id !== me.id));
  }

  async function loadChannels() {
    const { data: memberships } = await supabase
      .from('channel_members')
      .select('channel_id, encrypted_channel_key, key_iv')
      .eq('user_id', me.id);
    if (!memberships || memberships.length === 0) { setMyChannels([]); return; }

    const ids = memberships.map((m) => m.channel_id);
    const { data: channels } = await supabase
      .from('channels')
      .select('*')
      .in('id', ids)
      .order('created_at', { ascending: false });

    setMyChannels(channels || []);

    // Unwrap each channel's key for us, using the creator's public key.
    const keyMap = { ...channelKeys };
    for (const m of memberships) {
      if (!m.encrypted_channel_key || keyMap[m.channel_id]) continue;
      const channel = channels.find((c) => c.id === m.channel_id);
      if (!channel) continue;
      const creator = usersMap[channel.created_by];
      const creatorPublicKey = creator?.public_key
        || (await supabase.from('public_users').select('public_key').eq('id', channel.created_by).single()).data?.public_key;
      if (!creatorPublicKey) continue;
      try {
        keyMap[m.channel_id] = await unwrapChannelKey(m.encrypted_channel_key, m.key_iv, privateKey, creatorPublicKey);
      } catch { /* ignore, message decrypt will show placeholder */ }
    }
    setChannelKeys(keyMap);
  }

  async function loadStatuses() {
    const { data } = await supabase
      .from('statuses')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    setStatuses(data || []);
  }

  // ---- Messages for the active channel: load + realtime, decrypt as they arrive ----
  useEffect(() => {
    if (!activeChannel) return;
    const key = channelKeys[activeChannel.id];
    if (!key) { setMessages([]); return; }
    let sub;

    async function load() {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', activeChannel.id)
        .order('created_at', { ascending: true });
      const decrypted = await Promise.all((data || []).map(async (m) => ({
        ...m, content: await decryptMessage(key, m.ciphertext, m.iv),
      })));
      setMessages(decrypted);

      sub = supabase
        .channel(`messages-${activeChannel.id}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'messages',
          filter: `channel_id=eq.${activeChannel.id}`,
        }, async (payload) => {
          const content = await decryptMessage(key, payload.new.ciphertext, payload.new.iv);
          setMessages((prev) => [...prev, { ...payload.new, content }]);
        })
        .subscribe();
    }
    load();
    return () => { sub && supabase.removeChannel(sub); };
  }, [activeChannel, channelKeys]);

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function sendMessage(e) {
    e.preventDefault();
    const key = channelKeys[activeChannel?.id];
    if (!text.trim() || !activeChannel || !key) return;
    const { ciphertext, iv } = await encryptMessage(key, text.trim());
    await supabase.from('messages').insert({ channel_id: activeChannel.id, sender_id: me.id, ciphertext, iv });
    setText('');
  }

  async function createDirectOrGroup() {
    if (picked.length === 0) return;
    const isGroup = picked.length > 1;
    const name = isGroup ? (newChannelName.trim() || `Group (${picked.length + 1})`) : (usersMap[picked[0]]?.name || 'Chat');

    const { data: channel } = await supabase
      .from('channels').insert({ name, is_group: isGroup, created_by: me.id }).select().single();

    // Generate one AES key for this channel, wrap it individually for every
    // member (including ourselves) so only they can unwrap it.
    const channelKey = await generateChannelKey();
    const memberIds = [me.id, ...picked];
    const rows = await Promise.all(memberIds.map(async (uid) => {
      const memberPublicKey = usersMap[uid]?.public_key;
      const { encrypted_channel_key, key_iv } = await wrapChannelKeyForMember(channelKey, privateKey, memberPublicKey);
      return { channel_id: channel.id, user_id: uid, encrypted_channel_key, key_iv };
    }));
    await supabase.from('channel_members').insert(rows);

    setChannelKeys((prev) => ({ ...prev, [channel.id]: channelKey }));
    setShowNewChat(false);
    setPicked([]);
    setNewChannelName('');
    await loadChannels();
    setActiveChannel(channel);
  }

  async function createBroadcastChannel() {
    if (!newChannelName.trim()) return;
    const { data: channel } = await supabase
      .from('channels').insert({ name: newChannelName.trim(), is_broadcast: true, created_by: me.id }).select().single();

    const channelKey = await generateChannelKey();
    const { encrypted_channel_key, key_iv } = await wrapChannelKeyForMember(channelKey, privateKey, me.public_key);
    await supabase.from('channel_members').insert({ channel_id: channel.id, user_id: me.id, encrypted_channel_key, key_iv });

    setChannelKeys((prev) => ({ ...prev, [channel.id]: channelKey }));
    setShowNewChannel(false);
    setNewChannelName('');
    await loadChannels();
    setActiveChannel(channel);
  }

  async function postStatus() {
    if (!statusText.trim()) return;
    await supabase.from('statuses').insert({ user_id: me.id, content: statusText.trim() });
    setStatusText('');
    loadStatuses();
  }

  async function saveSettings() {
    // About text isn't secret, so it's fine to update through a simple RPC-free path.
    // We route this through login-less update by re-using the signup API's admin
    // access isn't available client-side, so for a prototype we just show it locally.
    alert('Saved locally for this session. Wire this to a small /api/profile route if you want it persisted.');
  }

  function logout() {
    clearSession();
    router.push('/');
  }

  if (!me) return null;

  if (needsUnlock) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={handleUnlock}>
          <h1>Welcome back, {me.name}</h1>
          <p>Enter your password to unlock your encrypted chats on this device.</p>
          <input type="password" placeholder="Password" value={unlockPassword}
            onChange={(e) => setUnlockPassword(e.target.value)} autoFocus />
          {unlockError && <p style={{ color: '#d33', fontSize: 13, marginBottom: 10 }}>{unlockError}</p>}
          <button type="submit">Unlock</button>
        </form>
      </div>
    );
  }

  const chats = myChannels.filter((c) => !c.is_broadcast);
  const channelsOnly = myChannels.filter((c) => c.is_broadcast);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="me">
            <div className="avatar" style={{ background: me.avatar_color }}>{me.name[0]?.toUpperCase()}</div>
            {me.name}
          </div>
          <button className="icon-btn" onClick={logout} title="Log out">⎋</button>
        </div>
        <div className="tabs">
          <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>Chats</button>
          <button className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>Channels</button>
          <button className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>Status</button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
        </div>

        {tab === 'chats' && (
          <>
            <button className="new-chat-btn" onClick={() => setShowNewChat(true)}>+ New chat</button>
            <div className="chat-list">
              {chats.map((c) => (
                <div key={c.id} className="chat-row" onClick={() => setActiveChannel(c)}>
                  <div className="avatar" style={{ background: '#25D366' }}>{c.name[0]?.toUpperCase()}</div>
                  <div className="meta">
                    <div className="name">{c.name}</div>
                    <div className="preview">🔒 {c.is_group ? 'Encrypted group chat' : 'Encrypted chat'}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'channels' && (
          <>
            <button className="new-chat-btn" onClick={() => setShowNewChannel(true)}>+ New channel</button>
            <div className="chat-list">
              {channelsOnly.map((c) => (
                <div key={c.id} className="chat-row" onClick={() => setActiveChannel(c)}>
                  <div className="avatar" style={{ background: '#128C7E' }}>📢</div>
                  <div className="meta"><div className="name">{c.name}</div><div className="preview">Broadcast channel</div></div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'status' && (
          <div className="chat-list">
            <div className="status-row">
              <textarea rows={2} placeholder="What's on your mind?" value={statusText} onChange={(e) => setStatusText(e.target.value)} />
              <button className="new-chat-btn" style={{ margin: '8px 0 0' }} onClick={postStatus}>Post update</button>
            </div>
            {statuses.map((s) => (
              <div key={s.id} className="status-row">
                <strong>{usersMap[s.user_id]?.name || 'Someone'}</strong>
                <div>{s.content}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'settings' && (
          <div className="settings-panel">
            <div className="field"><label>Name</label><input value={me.name} disabled /></div>
            <div className="field"><label>About</label><input value={about} onChange={(e) => setAbout(e.target.value)} /></div>
            <button className="new-chat-btn" onClick={saveSettings}>Save</button>
          </div>
        )}
      </div>

      <div className="main-panel">
        {!activeChannel && <div className="main-empty">Select a chat to start messaging</div>}
        {activeChannel && (
          <>
            <div className="chat-header">
              <div className="title">{activeChannel.name} 🔒</div>
              {!activeChannel.is_broadcast && (
                <>
                  <button className="icon-btn" onClick={() => setCall({ channelId: activeChannel.id, video: false })}>📞</button>
                  <button className="icon-btn" onClick={() => setCall({ channelId: activeChannel.id, video: true })}>🎥</button>
                </>
              )}
            </div>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.sender_id === me.id ? 'mine' : 'theirs'}`}>
                  {m.sender_id !== me.id && <div className="sender">{usersMap[m.sender_id]?.name || 'Someone'}</div>}
                  <div>{m.content}</div>
                  <div className="time">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              ))}
              <div ref={scrollRef} />
            </div>
            {(!activeChannel.is_broadcast || activeChannel.created_by === me.id) && (
              <form className="composer" onSubmit={sendMessage}>
                <input placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)} />
                <button type="submit">➤</button>
              </form>
            )}
          </>
        )}
      </div>

      {showNewChat && (
        <div className="modal-overlay" onClick={() => setShowNewChat(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New chat</h2>
            {picked.length > 1 && (
              <input placeholder="Group name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
            )}
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {otherUsers.map((u) => (
                <label key={u.id} className="user-pick">
                  <input type="checkbox" checked={picked.includes(u.id)}
                    onChange={(e) => setPicked((prev) => e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id))} />
                  <div className="avatar" style={{ background: u.avatar_color }}>{u.name[0]?.toUpperCase()}</div>
                  {u.name}
                </label>
              ))}
            </div>
            <div className="actions">
              <button className="secondary" onClick={() => setShowNewChat(false)}>Cancel</button>
              <button onClick={createDirectOrGroup}>Start chat</button>
            </div>
          </div>
        </div>
      )}

      {showNewChannel && (
        <div className="modal-overlay" onClick={() => setShowNewChannel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New channel</h2>
            <input placeholder="Channel name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
            <div className="actions">
              <button className="secondary" onClick={() => setShowNewChannel(false)}>Cancel</button>
              <button onClick={createBroadcastChannel}>Create</button>
            </div>
          </div>
        </div>
      )}

      {call && <CallPanel channelId={call.channelId} me={me} video={call.video} onClose={() => setCall(null)} />}
    </div>
  );
}
