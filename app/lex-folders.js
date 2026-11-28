// lex-folders.js — a folder of chats: Kolya, Other (supabase/migrations/folder_chats.sql).
//
// The database of Gennady sorts the people he writes with into folders by its cases (Kolya — the people
// and the groups of the cases of Kolya; Other — the working people outside them and outside Profi.ru),
// and the relay brings every chat of a folder into Lex with its past. The chats of a folder stand in
// «Flow» (lex-flow.js), under its chip Kolya and in «All», as lines this file draws (`line`);
// a press opens the chat beside that list (no arrow; from the board «Today» — the arrow back to it). A folder has no list of its own (20.11.2026).
// A chat of a folder is drawn by the order chat object of lex-profi.js (createChat with folder): one person — one
// chat from every messenger, the mark of the messenger at every message, files as files.
//
// What is left of a folder here is its line with the menu of a chat (lex-chat-menu.js) and the photo or the letter of
// the person (lex-message.js avatar), the chats held ahead, and the watch over the server's signals that keeps an open
// chat of the folder up to date. The server decides what stands where and in which order (people_home); the page draws it.
(function (global) {
  'use strict';

  const newOpId = () => global.LexSection.newOpId();

  // The words under a line: the last message, «You:» before Gennady's.
  function lastWords(c) {
    const text = String(c.last || '').replace(/\s+/g, ' ').trim();
    return c.by === 'owner' && text ? `You: ${text}` : text;
  }

  // deps: folder (its id), title, signals, rpc, openChat(chatKey, wanted, held, keep) — a press on a line;
  // confirm(title, text, o); onChange(payload) — the database changed something of a folder (payload.chatKey — which
  // chat): the open chat reads itself again.
  function createSection(deps) {
    const frame = global.LexSection.createFrame({
      title: deps.title,
      cls: 'lex-folder',
      signals: deps.signals,
      // A message came into a chat of a folder, a chat moved, a chat was read, pinned or deleted: the
      // signal «folders» (lex_folder_touch).
      events: ['folders'],
      check: (signal) => poll(signal),
    });
    const { say } = frame;
    let rev = null;

    // The chats this window holds: every line that comes on the screen is read ahead (folder_item, nothing
    // read or written by it), and a press shows the chat from it at once.
    const held = global.LexSection.keep({ load: (key) => deps.rpc('folder_item', { p_chat_key: key }) });
    // the photo too: a new photo of the person is read again for the bar over the chat
    const stampOf = (c) => [c.at, c.last, c.unread, c.pinned, c.photo || '', c.tick || '', c.status || ''].join('|');
    const keepOf = (key) => (item) => held.put(key, item);
    // o.fail(text) — where a failure is told: the status line of this section is not on the screen.
    const openChat = (key, o) => frame.open(
      (wanted) => deps.openChat(key, wanted, held.get(key), keepOf(key)),
      'The chat did not open.', o && o.fail);

    const DELETE_TEXT = 'It disappears from Lex. Nothing changes in the messengers. '
      + 'A new message of the person brings it back.';
    async function chatAct(c, act, o) {
      try {
        // The mark is not a line of the list: the numbers of the unread carry it, and the signal «unread»
        // brings them to every device (important_chats.sql).
        if (act === 'important' || act === 'unimportant') global.LexSection.markImportant(c.chatKey, act === 'important');
        if (act === 'mute' || act === 'unmute') global.LexSection.markMuted(c.chatKey, act === 'mute');
        await deps.rpc('chat_act', { p_op_id: newOpId(), p_chat_key: c.chatKey, p_act: act });
      } catch (e) {
        if (act === 'important' || act === 'unimportant') global.LexSection.markImportant(c.chatKey, act !== 'important');
        if (act === 'mute' || act === 'unmute') global.LexSection.markMuted(c.chatKey, act !== 'mute');
        const text = (e && e.message) || 'It did not work.';
        if (o && o.fail) o.fail(text); else say(text, true);
        return;
      }
      if (['important', 'unimportant', 'mute', 'unmute'].includes(act)) return;
      if (o && o.after) o.after();
    }

    // A line of a chat (В7.34): the photo of the person (folder_photos.sql) or the letter of the person or
    // the group 48 (В7.12), the name, the time, the pin of a pinned one, the last message. The mark of the
    // messenger stands only inside the chat, at every message (Gennady, 20.11.2026): the list is a plain list
    // of chats, with the number of the unread. The photo comes with the person's own pass, as the files of a message.
    // o — «Flow» draws the line (lex-flow.js): { from, fail, after }.
    function chatLine(c, o) {
      const M = global.LexMessage;
      const io = global.LexFileAttach && global.LexFileAttach.webIo;
      const line = global.LexSection.row({
        lead: M.avatar(c.title || '?', { size: 48, photo: c.photo, io }),
        title: c.title || 'Chat', sub: lastWords(c), dot: !!c.unread, onClick: () => openChat(c.chatKey, o),
        // The ticks under Gennady's last message, as in the lines of Profi.ru: the step of the ladder `status`
        // (message_status_ladder.sql), a server before it — `tick`.
        end: M.tickStatus(c, c.tick) ? M.ticks(M.tickStatus(c, c.tick)) : null,
        // what the agent «Кто это» waits for here (В7.54): «Lex: <its headline>» in place of the last message
        lex: c.whois && c.whois.wait ? c.whois.wait : null,
        time: global.LexSection.listTime(c.at), pinned: !!c.pinned,
        unread: { chat: c.chatKey, number: true },
        // The draft of the chat, while it has one: «Draft: …» in place of the last message.
        draft: c.chatKey || null,
      });
      if (global.LexChatMenu) {
        const act = (name) => chatAct(c, name, o);
        global.LexChatMenu.attach(line, () => ({
          // Mark as read or unread by the one number of the chat (chat_read_one.sql), as its line shows it.
          title: c.title, pinned: !!c.pinned, unread: global.LexSection.chatUnread(c.chatKey) > 0, act,
          muted: global.LexSection.isMuted(c.chatKey),
          // Archive or Unarchive: the server's word of the line (chat_archive.sql); a server without it — no item
          archived: typeof c.archived === 'boolean' ? c.archived : undefined,
          // Open in new window (В7.79): the chat as a notification of the folder names it.
          window: c.chatKey ? { kind: 'folder_message', chatKey: c.chatKey, folder: deps.folder || '' } : null,
          important: global.LexSection.isImportant(c.chatKey),
          remove: () => global.LexChatMenu.remove({ confirm: deps.confirm, text: DELETE_TEXT, act }),
        }));
      }
      held.watch(line, c.chatKey, stampOf(c));
      return line;
    }

    // A signal of the folders: the stamp it carries says whether this window saw it already. The chat that
    // is open reads itself (onChange); Flow follows the same signal by itself (lex-flow.js).
    async function poll(signal) {
      const told = signal && signal.payload && signal.payload.rev != null ? Number(signal.payload.rev) : null;
      if (told != null && rev != null && told <= rev) return;
      const r = told != null ? told : await deps.rpc('folder_rev', {});
      if (r != null && r === rev) return;
      const seen = rev;
      try {
        // The signal names the chat it is about: the open chat reads itself only for its own.
        if (deps.onChange) await deps.onChange((signal && signal.payload) || null);
        if (r != null) rev = Math.max(Number(r) || 0, rev || 0);
      } catch (e) {
        rev = seen;
        throw e;
      }
    }

    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      // The line of a chat of this folder, for the main page of the people.
      line: chatLine,
      // The person left a chat of the folder: it is read again, so the next press shows it as it is now.
      visited(chatKey) { if (chatKey) held.ahead(chatKey, null); },
      // The chat that is open reads itself at the signals of the folders (the page starts the watch with the chat).
      watch() { frame.watch(); },
      unwatch() { frame.unwatch(); },
      hide() { this.unwatch(); },
    };
  }

  // A folder chat key (folder_chats.sql, lex_folder_is_key).
  // A chat of the folders, by the table of the profiles of chats (lex-chat-profile.js, KEYS).
  const isChatKey = (key) => typeof key === 'string' && !!global.LexChatProfile && global.LexChatProfile.kindOfKey(key) === 'person';

  global.LexFolders = { createSection, isChatKey, newOpId };
})(typeof window !== 'undefined' ? window : globalThis);
