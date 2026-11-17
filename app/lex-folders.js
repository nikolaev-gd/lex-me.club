// lex-folders.js — a folder of chats: Kolya, Other (supabase/migrations/folder_chats.sql).
//
// The database of Gennady sorts the people he writes with into folders by its cases (Kolya — the people
// and the groups of the cases of Kolya; Other — the working people outside them and outside Profi.ru),
// and the relay brings every chat of a folder into Lex with its past. A folder is a button under the
// list of chats; it opens the list of its chats, the way Profi.ru does. A chat of a folder is drawn by
// the order chat object of lex-profi.js (createChat with folder): one person — one chat from every
// messenger, the mark of the messenger at every message, files as files.
//
// The list is the frame of a section (lex-section.js) with its lines (row), the menu of a chat
// (lex-chat-menu.js) and the photo or the letter of the person (lex-message.js avatar). The server
// decides what stands where and in which order (folder_home); the page draws it.
(function (global) {
  'use strict';

  const make = (tag, cls, text) => global.LexSection.make(tag, cls, text);
  const newOpId = () => global.LexSection.newOpId();

  // The words under a line: the last message, «You:» before Gennady's.
  function lastWords(c) {
    const text = String(c.last || '').replace(/\s+/g, ' ').trim();
    return c.by === 'owner' && text ? `You: ${text}` : text;
  }

  // deps: folder (its id), title, back, signals, rpc, read (the window's way of reading, lex-reads.js),
  // openChat(chatKey, wanted, held, keep) — a press on a line; notify(text); confirm(title, text, o);
  // onChange(payload) — the database changed something of a folder (payload.chatKey — which chat): the open
  // chat reads itself again.
  function createSection(deps) {
    const readKept = deps.read || ((name, args, show) => deps.rpc(name, args).then((v) => { show(v, true, false); return v; }));
    const frame = global.LexSection.createFrame({
      title: deps.title,
      cls: 'lex-folder',
      back: deps.back,
      signals: deps.signals,
      // A message came into a chat of a folder, a chat moved, a chat was read, pinned or deleted: the
      // signal «folders» (lex_folder_touch).
      events: ['folders'],
      check: (signal) => poll(signal),
      notify: deps.notify,
      onBack: () => paint(),
    });
    const { say } = frame;
    let home = null;
    let rev = null;

    // The chats this window holds: every line that comes on the screen is read ahead (folder_item, nothing
    // read or written by it), and a press shows the chat from it at once.
    const held = global.LexSection.keep({ load: (key) => deps.rpc('folder_item', { p_chat_key: key }) });
    // the photo too: a new photo of the person is read again for the bar over the chat
    const stampOf = (c) => [c.at, c.last, c.unread, c.pinned, c.photo || ''].join('|');
    const keepOf = (key) => (item) => held.put(key, item);
    const openChat = (key) => frame.open(
      (wanted) => deps.openChat(key, wanted, held.get(key), keepOf(key)), 'The chat did not open.');

    async function reloadHome(show) {
      const v = await readKept('folder_home', { p_folder: deps.folder }, (list, fresh) => {
        if (!list || typeof list !== 'object') return;
        home = list;
        if (fresh && list.rev != null) rev = Math.max(Number(list.rev) || 0, rev || 0);
        if (show) show();
      });
      if (v && typeof v === 'object') home = v;
      return home;
    }

    const DELETE_TEXT = 'It disappears from Lex. Nothing changes in the messengers. '
      + 'A new message of the person brings it back.';
    async function chatAct(c, act) {
      try {
        await deps.rpc('chat_act', { p_op_id: newOpId(), p_chat_key: c.chatKey, p_act: act });
      } catch (e) {
        say((e && e.message) || 'It did not work.', true);
        return;
      }
      await reloadHome();
      if (frame.screen === 'home') paint();
    }

    // A line of a chat (В7.34): the photo of the person (folder_photos.sql) or the letter of the person or
    // the group 48 (В7.12), the name, the time, the pin of a pinned one, the last message with the mark of
    // the messenger it came by. The photo comes with the person's own pass, as the files of a message.
    function chatLine(c) {
      const M = global.LexMessage;
      const io = global.LexFileAttach && global.LexFileAttach.webIo;
      const line = global.LexSection.row({
        lead: M.avatar(c.title || '?', { size: 48, photo: c.photo, io }),
        title: c.title || 'Chat', sub: lastWords(c), dot: !!c.unread, onClick: () => openChat(c.chatKey),
        end: c.channel && M.CHANNELS[c.channel] ? M.channel(c.channel) : null,
        time: global.LexSection.listTime(c.at), pinned: !!c.pinned,
        unread: { chat: c.chatKey },
      });
      if (global.LexChatMenu) {
        const act = (name) => chatAct(c, name);
        global.LexChatMenu.attach(line, () => ({
          title: c.title, pinned: !!c.pinned, unread: !!c.unread, act,
          remove: () => global.LexChatMenu.remove({ confirm: deps.confirm, text: DELETE_TEXT, act }),
        }));
      }
      held.watch(line, c.chatKey, stampOf(c));
      return line;
    }

    function paint() {
      const { body } = frame;
      held.unwatch();
      body.replaceChildren();
      if (!home) return;
      const chats = Array.isArray(home.chats) ? home.chats : [];
      say(chats.length ? '' : 'No chats here yet.');
      if (!chats.length) return;
      const list = make('div', 'lex-section-list');
      for (const c of chats) list.appendChild(chatLine(c));
      body.appendChild(list);
    }

    // A signal of the folders: the stamp it carries says whether this window saw it already. The list
    // is read when it is on the screen; the open chat reads itself (onChange).
    async function poll(signal) {
      const told = signal && signal.payload && signal.payload.rev != null ? Number(signal.payload.rev) : null;
      if (told != null && rev != null && told <= rev) return;
      const r = told != null ? told : await deps.rpc('folder_rev', {});
      if (r != null && r === rev) return;
      const seen = rev;
      try {
        const reads = [];
        if (frame.isShown()) reads.push(reloadHome().then(() => { if (frame.screen === 'home') paint(); }));
        // The signal names the chat it is about: the open chat reads itself only for its own.
        if (deps.onChange) reads.push(deps.onChange((signal && signal.payload) || null));
        await Promise.all(reads);
        if (r != null) rev = Math.max(Number(r) || 0, rev || 0);
      } catch (e) {
        rev = seen;
        throw e;
      }
    }

    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      // The person left a chat of the folder: it is read again, so the next press shows it as it is now.
      visited(chatKey) { if (chatKey) held.ahead(chatKey, null); },
      async show() {
        frame.enter();
        this.watch();
        try {
          await reloadHome(() => { if (frame.screen === 'home') paint(); });
          paint();
        } catch (e) {
          say('The folder did not load. ' + ((e && e.message) || ''), true);
        }
      },
      async warm() {
        if (frame.isShown()) return;
        try {
          await reloadHome(() => { if (frame.screen === 'home') paint(); });
          if (!frame.isShown() && frame.screen === 'home') paint();
        } catch (e) {
          console.warn('[folders] warm:', e && e.message);
        }
      },
      watch() { frame.watch(); },
      unwatch() { frame.unwatch(); },
      hide() { this.unwatch(); },
    };
  }

  // A folder chat key (folder_chats.sql, lex_folder_is_key).
  const isChatKey = (key) => typeof key === 'string' && /^__lex_folder__[0-9]{1,18}$/.test(key);

  global.LexFolders = { createSection, isChatKey, newOpId };
})(typeof window !== 'undefined' ? window : globalThis);
