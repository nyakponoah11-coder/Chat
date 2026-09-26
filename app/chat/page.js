'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, getSession, clearSession, getPrivateKeyJwk, setPrivateKeyJwk } from '../../lib/supabase';
import {
  importPrivateKeyJwk, generateChannelKey, wrapChannelKeyForMember, unwrapChannelKey,
  encryptMessage, decryptMessage, deriveKeyFromPassword, decryptPrivateKey,
} from '../../lib/crypto';
import CallPanel from '../../components/CallPanel';
import EmojiPicker from '../../components/EmojiPicker';

export default function ChatPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [privateKey, setPrivateKey] = useState(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [showUnlockPassword, setShowUnlockPassword] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const [tab, setTab] = useState('chats'); // chats | people | channels | status | settings
  const [myChannels, setMyChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [channelKeys, setChannelKeys] = useState({});
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [usersMap, setUsersMap] = useState({});
  const [otherUsers, setOtherUsers] = useState([]);
  const [friends, setFriends] = useState([]);       // accepted, other user's id
  const [incoming, setIncoming] = useState([]);      // {id, from_user}
  const [outgoing, setOutgoing] = useState([]);      // to_user ids, pending

  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [picked, setPicked] = useState([]);
  const [newChannelName, setNewChannelName] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [statusText, setStatusText] = useState('');
  const [call, setCall] = useState(null);
  const [about, setAbout] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const s = getSession();
    if (!s) { router.push('/'); return; }
    setMe(s);
    setAbout(s.about || '');
    const cachedJwk = getPrivateKeyJwk();
    if (cachedJwk) importPrivateKeyJwk(cachedJwk).then(setPrivateKey);
    else setNeedsUnlock(true);
  }, [router]);

  async function handleUnlock(e) {
    e.preventDefault();
    setUnlockError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    } catch { setUnlockError('Incorrect password.'); }
  }

  useEffect(() => {
    if (!me || !privateKey) return;
    loadUsers();
    loadChannels();
    loadStatuses();
    loadFriendData();
  }, [me, privateKey]);

  async function loadUsers() {
    const { data } = await supabase.from('public_users').select('*');
    const map = {};
    (data || []).forEach((u) => { map[u.id] = u; });
    setUsersMap(map);
    setOtherUsers((data || []).filter((u) => u.id !== me.id));
  }

  async function loadFriendData() {
    const { data } = await supabase
      .from('friend_requests')
      .select('*')
      .or(`from_user.eq.${me.id},to_user.eq.${me.id}`);
    const rows = data || [];
    setFriends(rows.filter((r) => r.status === 'accepted').map((r) => (r.from_user === me.id ? r.to_user : r.from_user)));
    setIncoming(rows.filter((r) => r.status === 'pending' && r.to_user === me.id));
    setOutgoing(rows.filter((r) => r.status === 'pending' && r.from_user === me.id).map((r) => r.to_user));
  }

  async function sendFriendRequest(userId) {
    await supabase.from('friend_requests').insert({ from_user: me.id, to_user: userId, status: 'pending' });
    loadFriendData();
  }

  async function respondToRequest(request, accept) {
    await supabase.from('friend_requests').update({ status: accept ? 'accepted' : 'declined' }).eq('id', request.id);
    if (accept) {
      // Create the encrypted 1:1 channel now that both sides have agreed.
      const otherId = request.from_user;
      const otherName = usersMap[otherId]?.name || 'Chat';
      const { data: channel } = await supabase
        .from('channels').insert({ name: otherName, is_group: false, created_by: me.id }).select().single();
      const channelKey = await generateChannelKey();
      const rows = await Promise.all([me.id, otherId].map(async (uid) => {
        const memberPublicKey = usersMap[uid]?.public_key;
        const { encrypted_channel_key, key_iv } = await wrapChannelKeyForMember(channelKey, privateKey, memberPublicKey);
        return { channel_id: channel.id, user_id: uid, encrypted_channel_key, key_iv };
      }));
      await supabase.from('channel_members').insert(rows);
      setChannelKeys((prev) => ({ ...prev, [channel.id]: channelKey }));
      await loadChannels();
    }
    loadFriendData();
  }

  async function loadChannels() {
    const { data: memberships } = await supabase
      .from('channel_members').select('channel_id, encrypted_channel_key, key_iv').eq('user_id', me.id);
    if (!memberships || memberships.length === 0) { setMyChannels([]); return; }
    const ids = memberships.map((m) => m.channel_id);
    const { data: channels } = await supabase.from('channels').select('*').in('id', ids).order('created_at', { ascending: false });
    setMyChannels(channels || []);

    const keyMap = { ...channelKeys };
    for (const m of memberships) {
      if (!m.encrypted_channel_key || keyMap[m.channel_id]) continue;
      const channel = channels.find((c) => c.id === m.channel_id);
      if (!channel) continue;
      let creatorPublicKey = usersMap[channel.created_by]?.public_key;
      if (!creatorPublicKey) {
        const { data } = await supabase.from('public_users').select('public_key').eq('id', channel.created_by).single();
        creatorPublicKey = data?.public_key;
      }
      if (!creatorPublicKey) continue;
      try { keyMap[m.channel_id] = await unwrapChannelKey(m.encrypted_channel_key, m.key_iv, privateKey, creatorPublicKey); }
      catch { /* ignore */ }
    }
    setChannelKeys(keyMap);
  }

  async function loadStatuses() {
    const { data } = await supabase.from('statuses').select('*').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false });
    setStatuses(data || []);
  }

  useEffect(() => {
    if (!activeChannel) return;
    const key = channelKeys[activeChannel.id];
    if (!key) { setMessages([]); return; }
    let sub;
    async function load() {
      const { data } = await supabase.from('messages').select('*').eq('channel_id', activeChannel.id).order('created_at', { ascending: true });
      const decrypted = await Promise.all((data || []).map(async (m) => ({ ...m, content: await decryptMessage(key, m.ciphertext, m.iv) })));
      setMessages(decrypted);
      sub = supabase.channel(`messages-${activeChannel.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${activeChannel.id}` },
          async (payload) => {
            const content = await decryptMessage(key, payload.new.ciphertext, payload.new.iv);
            setMessages((prev) => [...prev, { ...payload.new, content }]);
          })
        .subscribe();
    }
    load();
    return () => { sub && supabase.removeChannel(sub); };
  }, [activeChannel, channelKeys]);

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function sendEncrypted(content, type) {
    const key = channelKeys[activeChannel?.id];
    if (!activeChannel || !key) return;
    const { ciphertext, iv } = await encryptMessage(key, content);
    await supabase.from('messages').insert({ channel_id: activeChannel.id, sender_id: me.id, ciphertext, iv, type });
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!text.trim()) return;
    await sendEncrypted(text.trim(), 'text');
    setText('');
  }

  async function handleImagePick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeChannel) return;
    if (file.size > 4 * 1024 * 1024) { alert('Please pick an image under 4MB.'); return; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await sendEncrypted(dataUrl, 'image');
  }

  function insertEmoji(char) { setText((t) => t + char); }
  async function sendSticker(char) { setShowEmoji(false); await sendEncrypted(char, 'sticker'); }

  async function createGroupWithFriends() {
    if (picked.length === 0) return;
    const isGroup = picked.length > 1;
    const name = isGroup ? (newChannelName.trim() || `Group (${picked.length + 1})`) : (usersMap[picked[0]]?.name || 'Chat');
    const { data: channel } = await supabase.from('channels').insert({ name, is_group: isGroup, created_by: me.id }).select().single();
    const channelKey = await generateChannelKey();
    const memberIds = [me.id, ...picked];
    const rows = await Promise.all(memberIds.map(async (uid) => {
      const memberPublicKey = usersMap[uid]?.public_key;
      const { encrypted_channel_key, key_iv } = await wrapChannelKeyForMember(channelKey, privateKey, memberPublicKey);
      return { channel_id: channel.id, user_id: uid, encrypted_channel_key, key_iv };
    }));
    await supabase.from('channel_members').insert(rows);
    setChannelKeys((prev) => ({ ...prev, [channel.id]: channelKey }));
    setShowNewChat(false); setPicked([]); setNewChannelName('');
    await loadChannels();
    setActiveChannel(channel);
  }

  async function createBroadcastChannel() {
    if (!newChannelName.trim()) return;
    const { data: channel } = await supabase.from('channels').insert({ name: newChannelName.trim(), is_broadcast: true, created_by: me.id }).select().single();
    const channelKey = await generateChannelKey();
    const { encrypted_channel_key, key_iv } = await wrapChannelKeyForMember(channelKey, privateKey, me.public_key);
    await supabase.from('channel_members').insert({ channel_id: channel.id, user_id: me.id, encrypted_channel_key, key_iv });
    setChannelKeys((prev) => ({ ...prev, [channel.id]: channelKey }));
    setShowNewChannel(false); setNewChannelName('');
    await loadChannels();
    setActiveChannel(channel);
  }

  async function postStatus() {
    if (!statusText.trim()) return;
    await supabase.from('statuses').insert({ user_id: me.id, content: statusText.trim() });
    setStatusText(''); loadStatuses();
  }

  function saveSettings() { alert('Saved locally for this session. Wire this to a small /api/profile route if you want it persisted.'); }
  function logout() { clearSession(); router.push('/'); }

  if (!me) return null;

  if (needsUnlock) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={handleUnlock}>
          <h1>Welcome back, {me.name}</h1>
          <p>Enter your password to unlock your encrypted chats on this device.</p>
          <input type={showUnlockPassword ? 'text' : 'password'} placeholder="Password" value={unlockPassword}
            onChange={(e) => setUnlockPassword(e.target.value)} autoFocus />
          <button type="button" className="show-password-btn" onClick={() => setShowUnlockPassword((v) => !v)} style={{ marginBottom: 10 }}>
            {showUnlockPassword ? '🙈 Hide' : '👁️ Show'}
          </button>
          {unlockError && <p style={{ color: '#d33', fontSize: 13, marginBottom: 10 }}>{unlockError}</p>}
          <button type="submit">Unlock</button>
        </form>
      </div>
    );
  }

  const chats = myChannels.filter((c) => !c.is_broadcast);
  const channelsOnly = myChannels.filter((c) => c.is_broadcast);
  const discoverable = otherUsers.filter((u) => !friends.includes(u.id) && !outgoing.includes(u.id) && !incoming.some((r) => r.from_user === u.id));
  const friendUsers = otherUsers.filter((u) => friends.includes(u.id));

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

        <div className="sidebar-content">
          {tab === 'chats' && (
            <>
              <button className="new-chat-btn" onClick={() => setShowNewChat(true)}>+ New chat</button>
              <div className="chat-list">
                {chats.length === 0 && <p style={{ padding: 16, color: '#667781', fontSize: 13 }}>No chats yet. Add a friend in People, then start a chat.</p>}
                {chats.map((c) => (
                  <div key={c.id} className="chat-row" onClick={() => setActiveChannel(c)}>
                    <div className="avatar" style={{ background: '#25D366' }}>{c.name[0]?.toUpperCase()}</div>
                    <div className="meta"><div className="name">{c.name}</div><div className="preview">🔒 {c.is_group ? 'Encrypted group chat' : 'Encrypted chat'}</div></div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'people' && (
            <div className="chat-list">
              {incoming.length > 0 && (
                <>
                  <div className="section-label">Requests</div>
                  {incoming.map((r) => (
                    <div key={r.id} className="chat-row">
                      <div className="avatar" style={{ background: usersMap[r.from_user]?.avatar_color }}>
                        {usersMap[r.from_user]?.name?.[0]?.toUpperCase()}
                      </div>
                      <div className="meta"><div className="name">{usersMap[r.from_user]?.name}</div><div className="preview">Wants to chat with you</div></div>
                      <button className="small-btn accept" onClick={() => respondToRequest(r, true)}>Accept</button>
                      <button className="small-btn decline" onClick={() => respondToRequest(r, false)}>Decline</button>
                    </div>
                  ))}
                </>
              )}
              <div className="section-label">Friends</div>
              {friendUsers.length === 0 && <p style={{ padding: '0 16px 10px', color: '#667781', fontSize: 13 }}>No friends yet.</p>}
              {friendUsers.map((u) => (
                <div key={u.id} className="chat-row">
                  <div className="avatar" style={{ background: u.avatar_color }}>{u.name[0]?.toUpperCase()}</div>
                  <div className="meta"><div className="name">{u.name}</div><div className="preview">Friend</div></div>
                </div>
              ))}
              <div className="section-label">People</div>
              {discoverable.map((u) => (
                <div key={u.id} className="chat-row">
                  <div className="avatar" style={{ background: u.avatar_color }}>{u.name[0]?.toUpperCase()}</div>
                  <div className="meta"><div className="name">{u.name}</div><div className="preview">New here</div></div>
                  <button className="small-btn add" onClick={() => sendFriendRequest(u.id)}>Add</button>
                </div>
              ))}
              {outgoing.length > 0 && (
                <>
                  <div className="section-label">Sent</div>
                  {otherUsers.filter((u) => outgoing.includes(u.id)).map((u) => (
                    <div key={u.id} className="chat-row">
                      <div className="avatar" style={{ background: u.avatar_color }}>{u.name[0]?.toUpperCase()}</div>
                      <div className="meta"><div className="name">{u.name}</div><div className="preview">Request sent</div></div>
                      <button className="small-btn" disabled>Pending</button>
                    </div>
                  ))}
                </>
              )}
            </div>
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
                <div key={s.id} className="status-row"><strong>{usersMap[s.user_id]?.name || 'Someone'}</strong><div>{s.content}</div></div>
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

        <div className="tabs bottom-nav">
          <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>💬<span>Chats</span></button>
          <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
            👥<span>People</span>{incoming.length > 0 && <span className="badge">{incoming.length}</span>}
          </button>
          <button className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>📢<span>Channels</span></button>
          <button className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>🟢<span>Status</span></button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>⚙️<span>Settings</span></button>
        </div>
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
                  {m.type === 'image' && <img src={m.content} alt="shared" className="chat-image" />}
                  {m.type === 'sticker' && <div className="sticker-message">{m.content}</div>}
                  {(!m.type || m.type === 'text') && <div>{m.content}</div>}
                  <div className="time">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              ))}
              <div ref={scrollRef} />
            </div>
            {(!activeChannel.is_broadcast || activeChannel.created_by === me.id) && (
              <div style={{ position: 'relative' }}>
                {showEmoji && <EmojiPicker onEmoji={insertEmoji} onSticker={sendSticker} onClose={() => setShowEmoji(false)} />}
                <form className="composer" onSubmit={sendMessage}>
                  <button type="button" className="icon-btn" onClick={() => setShowEmoji((v) => !v)}>😊</button>
                  <button type="button" className="icon-btn" onClick={() => fileInputRef.current?.click()}>📷</button>
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImagePick} />
                  <input placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)} />
                  <button type="submit">➤</button>
                </form>
              </div>
            )}
          </>
        )}
      </div>

      {showNewChat && (
        <div className="modal-overlay" onClick={() => setShowNewChat(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New chat</h2>
            {friendUsers.length === 0 && <p style={{ fontSize: 13, color: '#667781', marginBottom: 10 }}>Add some friends from the People tab first — you can only chat with people who've accepted your request.</p>}
            {picked.length > 1 && <input placeholder="Group name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />}
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {friendUsers.map((u) => (
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
              <button onClick={createGroupWithFriends} disabled={picked.length === 0}>Start chat</button>
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
