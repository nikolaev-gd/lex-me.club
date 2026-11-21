// wc-agents.js — the section «Agents» of the page and the Mac app (21.11.2026, supabase/functions/folder-agents).
//
// Gennady, 21.11.2026: a folder for every agent of the base, in a folder one chat per task. The section is the frame of
// every section (lex-section.js) and nothing of its own: the first screen is the list of the agents, a press opens the
// folder of one — its model, «New chat» and its task chats. A task chat opens as a chat of a folder does (wc-app.js
// openFolderChat), and the arrow leads back to the folder. The server decides what stands where and in which order
// (the agents with a waiting or an unread chat first; in a folder the waiting chats first); the page draws it.
// The extension has no such section: this file is the page's only (webchat/index.html).
//
// createSection(deps) — deps:
//   back                 the arrow of the window (lex-back.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   rpc(name, args)      a function of the database (lex_agent_chats)
//   call(body)           the edge function folder-agents: null — the list of the agents, { op, … } — the rest
//   openChat(agent, chatKey, wanted)   a press on a task chat
//   newChat(agent)       a press on «New chat»: an empty chat of that agent with the field
//   pickModel(anchor, agent)           a press on the line of the model: the common menu of the models
//   chatOpen()           → true while a task chat of this section is on the screen
//   onChange(payload)    a signal while that chat is open: it reads itself again (payload — of the signal «folders»)
(function (global) {
  'use strict';

  // What a task chat is doing, in the line under its title (state of lex_agent_chats).
  const STATE_WORDS = { waiting: 'Waiting for you', working: 'Agent is working', closed: 'Closed' };
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // The model of an agent as the menus of the models name it: «Opus 5.5 · high» (the registry: anthropic:<model>:<effort>).
  const modelId = (a) => (a && a.model ? `anthropic:${a.model}:${a.effort || ''}` : '');
  function modelLabel(a) {
    const id = modelId(a);
    if (!id) return 'Not set';
    const R = global.LexAnswerRow;
    return (R && R.modelLabel(id)) || `${a.model} · ${a.effort || ''}`;
  }

  function createSection(deps) {
    const S = global.LexSection;
    // The agents of the base by key, as the last reading of the list brought them; the agent whose folder is open.
    let agents = [];
    const byKey = new Map();
    let current = null;
    let chats = [];

    const frame = S.createFrame({
      title: 'Agents',
      cls: 'lex-agents',
      back: deps.back,
      signals: deps.signals,
      // A task chat got a word, moved or was read (lex_folder_touch → «folders»); the numbers of the unread changed.
      events: ['folders', 'unread'],
      check: (signal) => look(signal),
      // Back to the list: it is read again, its numbers may have moved.
      onBack: (id) => { if (id === 'home') { current = null; readList().catch((e) => console.warn('[agents] back:', e && e.message)); } },
    });
    const { say } = frame;

    // A refusal of the server stands in the status line with its words; a call that did not go says nothing (Gennady,
    // 20.11.2026: the screen keeps what it has, the frame tries again).
    function refused(e) {
      if (e && e.status) say(String(e.message || ''));
      else throw e;
    }

    // ── the first screen: the agents ──────────────────────────────────────────────────────────────────────────
    // A line: the name, the goal in one line; the chats that wait for Gennady or have an unread word — the number at
    // the name, and the line strong then, as the line of Questions with its number.
    function paintList() {
      if (frame.screen !== 'home') return;
      const list = S.make('div', 'lex-section-list');
      for (const a of agents) {
        const n = (Number(a.waiting) || 0) + (Number(a.unread) || 0);
        list.appendChild(S.row({
          id: a.key, title: a.name || a.key, sub: oneLine(a.goal), strong: n > 0, mark: n > 0 ? String(n) : null,
          onClick: () => openFolder(a),
        }));
      }
      frame.body.replaceChildren(list);
      if (!agents.length) say('No agents yet.');
      else if (frame.screen === 'home') say('');
    }
    async function readList() {
      let got;
      try { got = await deps.call(null); } catch (e) { refused(e); return; }
      agents = Array.isArray(got && got.agents) ? got.agents.filter((a) => a && a.key) : [];
      byKey.clear();
      for (const a of agents) byKey.set(a.key, a);
      if (current && byKey.has(current.key)) current = byKey.get(current.key);
      paintList();
      if (frame.screen === 'agent') paintFolder();
    }

    // ── the folder of an agent ────────────────────────────────────────────────────────────────────────────────
    // On top the model of the agent (a press — the common menu of the models, Anthropic only), then «New chat», then
    // the task chats: the title, what it is doing and the last word, the time, the number of the unread. A chat that
    // waits for Gennady or where the agent works is strong; a closed one is not — it stays in the list, dimmed.
    function paintFolder() {
      if (frame.screen !== 'agent' || !current) return;
      const a = current;
      const list = S.make('div', 'lex-section-list');
      list.appendChild(S.row({ id: 'model', title: 'Model', sub: modelLabel(a), onClick: (e) => deps.pickModel(e.currentTarget, a) }));
      list.appendChild(S.row({ id: 'new', title: 'New chat', strong: true, onClick: () => deps.newChat(a) }));
      for (const c of chats) {
        const words = STATE_WORDS[c.state] || STATE_WORDS.working;
        const last = oneLine(c.last);
        list.appendChild(S.row({
          id: c.chatKey, title: c.title || 'Chat', sub: last ? `${words} · ${last}` : words,
          time: S.listTime(c.at), unread: { chat: c.chatKey }, strong: c.state !== 'closed',
          onClick: () => frame.open((wanted) => deps.openChat(a, c.chatKey, wanted), 'The chat did not open.'),
        }));
      }
      frame.body.replaceChildren(list);
    }
    async function readFolder() {
      const a = current;
      if (!a) return;
      const got = await deps.rpc('lex_agent_chats', { p_agent: a.key });
      if (current !== a && !(current && current.key === a.key)) return;
      chats = Array.isArray(got) ? got.filter((c) => c && c.chatKey) : [];
      paintFolder();
    }
    function openFolder(a) {
      current = a;
      chats = [];
      frame.push({ id: 'agent', title: a.name || a.key });
      paintFolder();
      readFolder().catch((e) => say(`The chats did not come. ${(e && e.message) || ''}`.trim(), true));
    }

    // The screen on top read again (a signal, the section shown again); a task chat on the screen reads itself.
    async function readScreen() {
      if (frame.screen === 'agent') await Promise.all([readFolder(), readList()]);
      else await readList();
    }
    async function look(signal) {
      if (deps.chatOpen()) {
        const ev = signal && signal.event;
        await deps.onChange(ev === 'folders' ? (signal.payload || null) : null);
      }
      if (frame.isShown()) await readScreen();
    }

    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      // The section entered from its button: the list; back from a task chat (opts.back) — the screen it was left on.
      async show(opts) {
        if (!(opts && opts.back)) { frame.reset(); current = null; }
        frame.enter();
        try { await readScreen(); } catch (e) { console.warn('[agents] show:', e && e.message); }
        if (frame.isShown()) frame.watch();
      },
      // The server names the section: its list is read before it is shown (and the model of an agent is known in its chats).
      async warm() { if (!frame.isShown()) await readList(); },
      hide() { frame.unwatch(); },
      // A task chat of the section follows the signals while it is open (wc-app.js enterProfiChat); left — it stops.
      watch() { frame.watch(); },
      unwatch() { frame.unwatch(); },
      // A notification or a link: the frame stands on the folder of that agent before the chat opens over it, so the
      // arrow of the chat leads there. → the agent ({ key, name }).
      async enter(key) {
        if (!byKey.has(key)) await readList().catch((e) => console.warn('[agents] list:', e && e.message));
        const a = byKey.get(key) || { key, name: key };
        frame.reset();
        openFolder(a);
        return a;
      },
      agent: (key) => byKey.get(key) || null,
      // The agent's model changed: the list (and the folder on the screen) read again, the new value shown.
      readList,
    };
  }

  global.WcAgents = { createSection, modelId, modelLabel, STATE_WORDS };
})(typeof window !== 'undefined' ? window : globalThis);
