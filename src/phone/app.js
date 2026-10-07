/* Phone thin client. All inference stays on the desktop. No model download UI. */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: localStorage.getItem('cipher_session') || '',
    mode: null, // 'bot' | 'room'
    botId: null,
    roomId: null,
    chatId: null,
    busy: false,
    es: null,
  };

  function headers(json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (state.token) h['Authorization'] = 'Bearer ' + state.token;
    return h;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    // 423: Cipher is locked on the desktop. Everything is refused (pairing too) until it's unlocked there.
    if (res.status === 423) { closeEvents(); setBusy(false); show('locked'); throw new Error(body.error || 'Cipher is locked on the desktop.'); }
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }

  function show(view) {
    $('locked-view').hidden = view !== 'locked';
    $('pair-view').hidden = view !== 'pair';
    $('list-view').hidden = view !== 'list';
    $('chat-view').hidden = view !== 'chat';
  }

  async function ensurePaired() {
    try {
      // Always ask first: while Cipher is locked on the desktop this shows the locked message, even before pairing.
      const st = await api('/api/status', { headers: headers() });
      if (!state.token) { show('pair'); return false; }
      if (!st.paired) { state.token = ''; localStorage.removeItem('cipher_session'); show('pair'); return false; }
      return true;
    } catch {
      if ($('locked-view').hidden) show('pair');
      return false;
    }
  }

  async function pair() {
    $('pair-error').hidden = true;
    const code = $('pair-code').value.trim();
    try {
      const r = await api('/api/pair', { method: 'POST', headers: headers(true), body: JSON.stringify({ code }) });
      state.token = r.token;
      localStorage.setItem('cipher_session', r.token);
      await loadList();
    } catch (e) {
      $('pair-error').textContent = e.message || String(e);
      $('pair-error').hidden = false;
    }
  }

  async function loadList() {
    show('list');
    const bots = await api('/api/bots', { headers: headers() });
    const rooms = await api('/api/rooms', { headers: headers() });
    const botList = $('bot-list');
    botList.replaceChildren();
    for (const b of bots.bots) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item';
      btn.textContent = b.name;
      btn.addEventListener('click', () => openBot(b.id, b.name));
      botList.append(btn);
    }
    const roomList = $('room-list');
    roomList.replaceChildren();
    for (const r of rooms.rooms) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item';
      const title = (r.name && r.name.trim()) || (r.members || []).map((m) => m.name).join(', ') || 'Room';
      btn.textContent = title;
      btn.addEventListener('click', () => openRoom(r.id, title));
      roomList.append(btn);
    }
    $('list-empty').hidden = bots.bots.length > 0 || rooms.rooms.length > 0;
  }

  function setBusy(busy) {
    state.busy = busy;
    $('send').hidden = busy;
    $('stop').hidden = !busy;
  }

  function closeEvents() {
    if (state.es) { state.es.close(); state.es = null; }
  }

  function appendMsg(role, text, who) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (who) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = who;
      div.append(w);
    }
    div.append(document.createTextNode(text));
    $('messages').append(div);
    $('messages').scrollTop = $('messages').scrollHeight;
    return div;
  }

  async function openBot(botId, name) {
    closeEvents();
    state.mode = 'bot';
    state.botId = botId;
    state.roomId = null;
    show('chat');
    $('chat-title').textContent = name;
    $('messages').replaceChildren();
    const data = await api('/api/bots/' + botId + '/chat', { headers: headers() });
    state.chatId = data.chatId;
    for (const m of data.messages) appendMsg(m.role, m.content);
    state.es = new EventSource('/api/bots/' + botId + '/events?token=' + encodeURIComponent(state.token));
    // The stream ends when the desktop locks: check the status, which shows the locked message if so.
    state.es.onerror = () => { api('/api/status', { headers: headers() }).catch(() => {}); };
    // EventSource can't set Authorization; use cookie set at pair time.
    let live = null;
    state.es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'token') {
        if (!live) live = appendMsg('assistant', '');
        live.textContent += d.text;
        $('messages').scrollTop = $('messages').scrollHeight;
        setBusy(true);
      } else if (d.type === 'message' && d.message && d.message.role === 'user') {
        appendMsg('user', d.message.content);
      } else if (d.type === 'message' && d.message && d.message.role === 'assistant') {
        if (live) { live.textContent = d.message.content; live = null; }
        else appendMsg('assistant', d.message.content);
      } else if (d.type === 'done' || d.type === 'error') {
        live = null;
        setBusy(false);
        if (d.type === 'error') appendMsg('note', d.error);
      }
    };
  }

  async function openRoom(roomId, name) {
    closeEvents();
    state.mode = 'room';
    state.roomId = roomId;
    state.botId = null;
    show('chat');
    $('chat-title').textContent = name;
    $('messages').replaceChildren();
    const data = await api('/api/rooms/' + roomId + '/messages', { headers: headers() });
    for (const m of data.messages) {
      if (m.role === 'user') appendMsg('user', m.content);
      else appendMsg('assistant', m.content, 'Bot ' + (m.botId ?? ''));
    }
    state.es = new EventSource('/api/rooms/' + roomId + '/events?token=' + encodeURIComponent(state.token));
    // The stream ends when the desktop locks: check the status, which shows the locked message if so.
    state.es.onerror = () => { api('/api/status', { headers: headers() }).catch(() => {}); };
    let live = null;
    state.es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'speaker') {
        live = appendMsg('assistant', '', 'Bot ' + d.botId);
        setBusy(true);
      } else if (d.type === 'token') {
        if (!live) live = appendMsg('assistant', '', 'Bot ' + d.botId);
        // who span + text
        const who = live.querySelector('.who');
        live.textContent = '';
        if (who) live.append(who);
        live.append(document.createTextNode((live._t = (live._t || '') + d.text)));
        $('messages').scrollTop = $('messages').scrollHeight;
      } else if (d.type === 'message' && d.message) {
        if (d.message.role === 'user') appendMsg('user', d.message.content);
        else {
          if (live) {
            live.textContent = '';
            const who = document.createElement('span');
            who.className = 'who';
            who.textContent = 'Bot ' + (d.message.botId ?? '');
            live.append(who, document.createTextNode(d.message.content));
            live = null;
          } else appendMsg('assistant', d.message.content, 'Bot ' + (d.message.botId ?? ''));
        }
      } else if (d.type === 'done' || d.type === 'error') {
        live = null;
        setBusy(false);
        if (d.type === 'error') appendMsg('note', d.error);
      }
    };
  }

  async function send(e) {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text || state.busy) return;
    $('input').value = '';
    setBusy(true);
    try {
      if (state.mode === 'bot') {
        await api('/api/bots/' + state.botId + '/send', { method: 'POST', headers: headers(true), body: JSON.stringify({ text }) });
      } else {
        await api('/api/rooms/' + state.roomId + '/send', { method: 'POST', headers: headers(true), body: JSON.stringify({ text }) });
      }
    } catch (err) {
      setBusy(false);
      appendMsg('note', err.message || String(err));
    }
  }

  async function stop() {
    try {
      if (state.mode === 'bot') await api('/api/bots/' + state.botId + '/stop', { method: 'POST', headers: headers() });
      else await api('/api/rooms/' + state.roomId + '/stop', { method: 'POST', headers: headers() });
    } catch { /* ignore */ }
  }

  $('locked-retry').addEventListener('click', async () => { if (await ensurePaired()) await loadList().catch(() => {}); });
  $('pair-btn').addEventListener('click', () => void pair());
  $('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void pair(); } });
  $('back').addEventListener('click', () => { closeEvents(); setBusy(false); void loadList(); });
  $('composer').addEventListener('submit', (e) => void send(e));
  $('stop').addEventListener('click', () => void stop());

  (async () => {
    if (await ensurePaired()) await loadList();
  })();
})();
