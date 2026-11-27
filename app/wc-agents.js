// wc-agents.js — the section «Agents» of the page and the Mac app (21.11.2026; by the boards of 22.11.2026: AgList,
// AgF2HeadA, AgF2Log, AgF2Wide, AgPassport, AgInstruction, AgMemory, AgAskRun; supabase/functions/folder-agents).
//
// Gennady, 21.11.2026: a folder for every agent of the base, in a folder one chat per task; 22.11.2026: the name of the
// agent in the middle of the head opens its passport (the settings), «Activity» on the right opens its journal, a new
// chat begins by a word in the field at the bottom of the folder — there are no lines «Model» and «New chat» any more.
// The section is the frame of every section (lex-section.js) and its parts (agentRow, groupLabel, settingRow, toggle,
// liveStage …); nothing is drawn here past them. Screens of the frame:
//   home         the list of the agents (agentRow): the waiting first, then the working, the rest by their last event,
//                the paused at the bottom
//   agent        the folder of one agent: the head in the middle, the groups «Waiting for you · N», «Working · N»,
//                «Closed» — or by date, or none (the order of the list at the left of the head, В7.73,
//                lex-list-order.js); the capsule «New chat» of the window at its bottom right begins a chat with the agent
//   log          the journal «Activity» (op runs, by pages, by days); a bubble at a line — a new chat about it
//   screen       the agent's own main screen (26.11.2026, the contract «Scribe в Lex»; an agent whose list line says
//                `screen: true`, Scribe first): the blocks of place «main» as the base describes them (wc-agent-screen.js)
//                — Scribe's totals and history; a press on such an agent's line opens it (the coordinator's rule of
//                26.11.2026, one for the page, the Mac and the iPhone), «Chats» at the right of its head opens the folder
//   passport     the face 96, the name, the state, About, the blocks of place «card» (Scribe: Model, Recording
//                description, Keys on this Mac), Text model (only an agent with a text model), Notify me, Paused,
//                Instruction, Memory
//   archived     the archived task chats of the agent (2026-11-23, chat_archive.sql): the row «Archived» at the top of
//                the folder opens it; the same lines, their menu says Unarchive; a word of the agent puts a chat back
//   instruction  the instruction of the agent, read only (Markdown)
//   memory       the notes of its memory, read only
// A task chat opens as a chat of a folder does (wc-app.js openFolderChat), and the arrow leads back to the folder. On a
// wide window the window puts the folder on the left of the open chat (wc-app.js paintSplit); the journal then stands on
// the right, in a frame of its own (aside), in the place of the chat.
// The extension has no such section: this file is the page's only (webchat/index.html).
//
// createSection(deps) — deps:
//   back                 the arrow of the window (lex-back.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   rpc(name, args)      a function of the database (lex_agent_chats, lex_agent_archived, chat_act)
//   call(body)           the edge function folder-agents: null — the list of the agents, { op, … } — the rest
//   openChat(agent, chatKey, wanted)   a press on a task chat
//   ask(agent, run)      a press on the bubble of a line of the journal: a new chat with the quote of the line
//   pickModel(anchor, modelId, onPick(modelId))   the common menu of the models, Anthropic only
//   menu(anchor, items)  the menu with notes (WcUI.menu, В7.60)
//   confirm(title, body, opts), prompt(title, value, opts)   the page's question (WcUI.confirm, WcUI.prompt): the
//                        agent's own screen asks with them (Delete, Recording description)
//   money(usd)           the money as the page writes it (WcUI.fmtMoney)
//   toast(text, error)   the line that pops up (В7.17)
//   markdown(host, text) the text of the instruction (WcMarkdown)
//   chatOpen()           → true while a task chat of this section is on the screen
//   openKey()            → the key of the task chat on the screen (its line stands picked on a wide window)
//   onScreen(id, agent)  the screen on top changed (the window paints its capsule, puts the folder beside the chat on a
//                        wide window)
//   wide()               → true when the window puts the folder beside the chat
//   onChange(payload)    a signal while that chat is open: it reads itself again (payload — of the signal «folders»)
(function (global) {
  'use strict';

  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // The word of a kind of work of the agents, where the base wrote no subject (the contract of 22.11.2026).
  const KIND_WORDS = {
    summary: 'Call summary', stitch: 'Calls stitched', deal: 'Deal updated', whois: 'Who is this', digest: 'Morning digest',
    correction: 'Instruction correction', order: 'Profi.ru order', lex_chat: 'Chat in Lex', chat: 'Task chat',
    attachment: 'Attachment read',
  };
  const actionWords = (x) => (x ? oneLine(x.subject) || KIND_WORDS[x.kind] || '' : '');

  // What the agent may notify about (В7.60: the menu with notes).
  // The two engines of an agent's session (Gennady's words, 26.11.2026).
  const ENGINES = [{ value: 'claude-subscription', label: 'Claude по подписке' }, { value: 'claude-key', label: 'Claude по ключу API' }];
  const engineLabel = (e) => (ENGINES.find((x) => x.value === e) || ENGINES[0]).label;
  // The row «Engine» under the models of the menu «Text model» of a task chat (model-picker-dropdown choiceRow): only an
  // agent that has an engine; the list of the section holds it.
  function engineChoice(agent, onChoose) {
    if (!agent || !agent.engine) return null;
    return { label: 'Engine', get: async () => ({ options: ENGINES.map((x) => ({ value: x.value, label: x.label })), current: agent.engine }), onChoose };
  }

  const NOTIFY = [
    { value: 'all', label: 'Waits or fails', note: 'When it waits for you and when it fails' },
    { value: 'waiting', label: 'When it waits for me', note: 'Only when it needs your word' },
    { value: 'none', label: 'Never', note: 'No notifications from this agent' },
  ];
  // What the pause stops (pause_main of the base): the Profi agent, the teacher, the assistant go on with their main work.
  const PAUSE_NOTE = {
    queue: 'Stops its work and chats. Catches up after.',
    skip: 'Stops its work and chats. Skipped work is not redone.',
    none: 'Stops its task chats. Its main work goes on.',
  };
  const STATES = new Set(['waiting', 'working', 'failed', 'paused', 'idle']);
  // The marks of the head and of a line of the journal: the clock of Activity, the bubble of a question.
  const CLOCK = ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 2'];
  const BUBBLE = ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'];

  // The model of an agent as the menus of the models name it: «Opus 5.5 · high» (the registry: anthropic:<model>:<effort>).
  const modelId = (a) => (a && a.model ? `anthropic:${a.model}:${a.effort || ''}` : '');
  function modelLabel(a) {
    const id = modelId(a);
    if (!id) return 'Not set';
    const R = global.LexAnswerRow;
    return (R && R.modelLabel(id)) || `${a.model} · ${a.effort || ''}`;
  }
  // The model of a line of the journal, without its level: «Opus 5.5».
  function runModel(model) {
    if (!model) return '';
    const R = global.LexAnswerRow;
    return (R && R.modelLabel(`anthropic:${model}:`)) || String(model);
  }

  // The state of an agent: the base's word; an older base without it — from the numbers of the mirror.
  function stateOf(a) {
    if (a && STATES.has(a.state)) return a.state;
    if (a && a.paused) return 'paused';
    if (a && Number(a.waiting) > 0) return 'waiting';
    if (a && Number(a.working) > 0) return 'working';
    if (a && a.failed_reason) return 'failed';
    return 'idle';
  }
  const timeOf = (a) => (a && ((a.last_action && a.last_action.at) || a.last_at)) || null;
  // The order of the list (board AgList): the agents that wait for Gennady (a chat waits), the working ones, the rest by
  // the time of their last event (a failure stands at its time), the paused ones at the bottom.
  function rank(a) {
    const s = stateOf(a);
    if (s === 'paused') return 3;
    if (s === 'waiting' || Number(a.waiting) > 0) return 0;
    if (s === 'working') return 1;
    return 2;
  }
  function sortAgents(list) {
    const at = (a) => Date.parse(timeOf(a) || '') || 0;
    return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || at(y.a) - at(x.a) || x.i - y.i).map((x) => x.a);
  }

  // «21 Nov», «21 Nov, 17:26» — the dates of the passport and of the instruction are English, as on the boards.
  function enDate(at, withTime) {
    const d = new Date(at);
    if (!at || Number.isNaN(d.getTime())) return '';
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d);
    if (!withTime) return day;
    const pad = (x) => String(x).padStart(2, '0');
    return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const hhmm = (at) => {
    const d = new Date(at);
    if (!at || Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function createSection(deps) {
    const S = global.LexSection;
    const make = S.make;
    // The agents of the base by key, as the last reading of the list brought them; the agent whose folder is open.
    let agents = [];
    const byKey = new Map();
    let current = null;
    let chats = [];
    // The archived task chats of the open folder (lex_agent_archived); null — not read yet.
    let archivedChats = null;
    // What the list says under a waiting agent: the last word of its waiting chat (its folder, read when it waits).
    const waitWords = new Map();
    // The passport of an agent as the base gave it (op about), by key.
    const about = new Map();
    // The agent's own screen (wc-agent-screen.js), by key: read when its main screen or its passport opens.
    const screens = new Map();
    function screenOf(a) {
      if (!a || !a.screen || !global.LexAgentScreen) return null;
      if (!screens.has(a.key)) {
        screens.set(a.key, global.LexAgentScreen.create({
          agent: a.key,
          call: deps.call,
          menu: deps.menu,
          toast: deps.toast,
          confirm: deps.confirm,
          prompt: deps.prompt,
          money: deps.money,
          onChange: () => { if (frame.screen === 'passport' && current && current.key === a.key) paintPassport(); },
        }));
      }
      return screens.get(a.key);
    }

    const frame = S.createFrame({
      title: 'Agents',
      cls: 'lex-agents',
      back: deps.back,
      signals: deps.signals,
      // A task chat got a word, moved or was read (lex_folder_touch → «folders»); the numbers of the unread changed;
      // an agent's own screen changed (agent_screen {agent}: a dictation, its price, a press elsewhere).
      events: ['folders', 'unread', 'agent_screen'],
      check: (signal) => look(signal),
      onBack: (id) => {
        if (id === 'home') { current = null; readList().catch((e) => console.warn('[agents] back:', e && e.message)); }
        if (id === 'agent') { paintHead(); readFolder().catch((e) => console.warn('[agents] folder:', e && e.message)); }
        if (id === 'archived') readFolder().catch((e) => console.warn('[agents] archive:', e && e.message));
        if (id === 'passport') paintPassport();
        if (id === 'screen') paintMain();
        told();
      },
    });
    const { say } = frame;
    // The window hears which screen is on top (the capsule of the agent, the folder beside the chat).
    const told = () => { if (deps.onScreen) deps.onScreen(frame.screen, current); };
    const push = (screen) => {
      const body = frame.push(screen);
      told();
      return body;
    };

    // A refusal of the server stands in the status line with its words; a call that did not go says nothing (Gennady,
    // 20.11.2026: the screen keeps what it has, the frame tries again).
    function refused(e) {
      if (e && e.status) say(String(e.message || ''));
      else throw e;
    }

    // ── the first screen: the agents (board AgList) ───────────────────────────────────────────────────────────
    // A line: the face 48, the name, the time of the last event, the state line (В7.57), the yellow dot while a chat
    // of the agent is unread — only the unread (Gennady, 24.11.2026); that it waits for him the state line says in words.
    // A paused agent is dimmed as a whole.
    function lineOf(a) {
      const state = stateOf(a);
      const o = { key: a.key, name: a.name || a.key, time: S.listTime(timeOf(a)), state, unread: Number(a.unread) || 0,
        onClick: () => (a.screen && global.LexAgentScreen ? openMain(a) : openFolder(a)) };
      if (state === 'waiting') o.text = waitWords.get(a.key) || actionWords(a.last_action) || oneLine(a.goal);
      else if (state === 'working') o.stage = a.stage || null;
      else if (state === 'failed') o.reason = oneLine(a.failed_reason);
      else if (state === 'idle') o.text = actionWords(a.last_action) || oneLine(a.goal);
      return o;
    }
    // The menu of an agent's line (В7.33, chat_read_one.sql): Mute or Unmute of the agent as a whole — the level between
    // «Agents' words» and one task chat; its chats with a position of their own keep it. A server before it — no menu.
    function agentMenu(row, a) {
      if (!global.LexChatMenu || !S.isAgentMuted) return;
      global.LexChatMenu.attach(row, () => {
        const muted = S.isAgentMuted(a.key);
        if (typeof muted !== 'boolean') return null;
        return { title: a.name || a.key, muted, mute: (on) => muteAgent(a, on) };
      });
    }
    async function muteAgent(a, on) {
      S.markAgentMuted(a.key, on);
      try {
        await deps.rpc('lex_notification_mode_set', { p_kind: 'agent', p_mode: on ? 'none' : 'inherit', p_scope: a.key });
      } catch (e) {
        S.markAgentMuted(a.key, !on);
        if (deps.toast) deps.toast((e && e.message) || 'It did not work.', true);
      }
    }
    function paintList() {
      const body = frame.screen === 'home' ? frame.body : null;
      if (!body) return;
      const list = make('div', 'lex-section-list');
      for (const a of agents) {
        const row = S.agentRow(lineOf(a));
        agentMenu(row, a);
        list.appendChild(row);
      }
      body.replaceChildren(list);
      if (!agents.length) body.replaceChildren(S.emptyState({ section: 'agents', title: 'No agents yet' }));
      say('');
    }
    // The last word of the chat that waits, for the line of a waiting agent: read from its folder, once per change.
    async function readWaitWords() {
      const want = agents.filter((a) => stateOf(a) === 'waiting');
      await Promise.all(want.map(async (a) => {
        const got = await deps.rpc('lex_agent_chats', { p_agent: a.key }).catch(() => null);
        const c = (Array.isArray(got) ? got : []).find((x) => x && x.state === 'waiting' && x.last);
        if (c) waitWords.set(a.key, oneLine(c.last));
      }));
      if (want.length) paintList();
    }
    async function readList() {
      let got;
      try { got = await deps.call(null); } catch (e) { refused(e); return; }
      agents = sortAgents(Array.isArray(got && got.agents) ? got.agents.filter((a) => a && a.key) : []);
      byKey.clear();
      for (const a of agents) byKey.set(a.key, a);
      if (current && byKey.has(current.key)) current = byKey.get(current.key);
      paintList();
      if (frame.screen === 'agent') paintHead();
      if (frame.screen === 'screen') paintMainHead();
      if (frame.screen === 'passport') paintPassport();
      readWaitWords().catch((e) => console.warn('[agents] waiting words:', e && e.message));
    }

    // ── the head of the screen of an agent (board AgF2HeadA) ─────────────────────────────────────────────────
    // In the middle the name with the chevron (a press — the passport), under it the state of the agent: «Waiting for
    // you · N» in yellow, «Working», «Failed», «Paused», otherwise nothing. On the right «Activity» — the journal.
    function stateLine(a) {
      const s = stateOf(a);
      const n = Number(a.waiting) || 0;
      if (n > 0 && s !== 'paused') return { sub: 'Waiting for you', subTone: 'attention' };
      if (s === 'working') return { sub: 'Working' };
      if (s === 'failed') return { sub: 'Failed' };
      if (s === 'paused') return { sub: 'Paused' };
      return {};
    }
    function folderHead(a) {
      return Object.assign({
        title: a.name || a.key,
        lead: orderButton(),
        onTitle: () => openPassport(a),
        titleLabel: `${a.name || a.key}: the passport`,
        action: { icon: (S.MARKS.tool && S.MARKS.tool.activity) || CLOCK, label: 'Activity', ariaLabel: 'Activity: what the agent did', onClick: () => openLog(a) },
      }, stateLine(a));
    }
    function paintHead() {
      if (frame.screen !== 'agent' || !current || typeof frame.setHead !== 'function') return;
      frame.setHead(folderHead(current));
    }

    // ── the folder of an agent ────────────────────────────────────────────────────────────────────────────────
    // The task chats by groups (В7.58): the waiting ones — the last word of the agent, under the label «Waiting for you»;
    // the working ones — the spinner and the stage; the closed ones — plain, the last word. The yellow dot and the bold
    // title are the unread's alone (the slot `unread` below, read again at every signal), whatever the state of the chat.
    // The time at the right. On a wide window the line of the chat on the right stands picked.
    function chatLine(c) {
      const working = c.state !== 'waiting' && c.state !== 'closed';
      const row = S.row({
        id: c.chatKey, title: c.title || 'Chat',
        sub: working ? S.agentState({ state: 'working', stage: c.stage, text: c.stageText || null }) : oneLine(c.last),
        time: S.listTime(c.at), unread: { chat: c.chatKey },
        onClick: () => frame.open((wanted) => deps.openChat(current, c.chatKey, wanted), 'The chat did not open.'),
      });
      row.classList.add('lex-agent-chat');
      // The menu of a chat (В7.33): Open in new window (В7.79), Mark as read or unread, Archive or Unarchive. A task
      // chat has no pin and no Delete chat in its folder: its place is the agent's state. The Cmd-click and the drag
      // of the same part; the agent itself and its folder give no window.
      if (global.LexChatMenu && c.chatKey && current) {
        const agent = current.key;
        global.LexChatMenu.attach(row, () => ({
          title: c.title || 'Chat',
          window: { kind: 'folder_message', chatKey: c.chatKey, agent },
          pinned: null,
          unread: (Number((S.unread().chats || {})[c.chatKey]) || 0) > 0,
          // A base before the archive gives no flag, and the menu has no Archive.
          archived: typeof c.archived === 'boolean' ? c.archived : undefined,
          // Mute of this one chat (chat_read_one.sql): absent while the server has none
          muted: S.isMuted ? S.isMuted(c.chatKey) : undefined,
          act: (name) => chatAct(c, name),
        }));
      }
      return row;
    }
    async function chatAct(c, act) {
      const mute = act === 'mute' || act === 'unmute';
      if (mute && S.markMuted) S.markMuted(c.chatKey, act === 'mute');
      try {
        await deps.rpc('chat_act', { p_op_id: S.newOpId(), p_chat_key: c.chatKey, p_act: act });
      } catch (e) {
        if (mute && S.markMuted) S.markMuted(c.chatKey, act !== 'mute');
        if (deps.toast) deps.toast((e && e.message) || 'It did not work.', true);
        return;
      }
      if (mute) return;
      readFolder().catch((e) => console.warn('[agents] folder:', e && e.message));
    }
    // The row «Archived» at the top of the folder: the face of the archive, the gray number of the archived chats.
    function archivedRow(n) {
      return S.row({ lead: S.sectionFace('archive', { size: 48 }), title: 'Archived', time: String(n), onClick: () => openArchived() });
    }
    function openArchived() {
      if (!current) return;
      push({ id: 'archived', title: 'Archived', head: { title: 'Archived', sub: current.name || current.key } });
      paintArchived();
      readFolder().catch((e) => say(`The chats did not come. ${(e && e.message) || ''}`.trim(), true));
    }
    function paintArchived() {
      if (frame.screen !== 'archived' || !current) return;
      if (!archivedChats) { frame.body.replaceChildren(); return; }
      if (!archivedChats.length) {
        frame.body.replaceChildren(make('div', 'lex-section-empty', 'No archived chats.'));
        return;
      }
      const list = make('div', 'lex-section-list');
      for (const c of archivedChats) list.appendChild(chatLine(c));
      frame.body.replaceChildren(list);
      pick(deps.openKey ? deps.openKey() : null);
    }
    // The order of the folder (В7.73): Group by Date updated | Date created | Status | None, Sort by Last updated | Date
    // created | Name, both ways. Each agent's folder has its own choice, kept on this device (`agent-chats:<agent>`); an
    // agent never set has the groups of the states.
    const orderKey = (a) => `agent-chats:${a.key}`;
    const L = global.LexListOrder;
    let order = L.norm();
    const CHAT_STATES = [
      { id: 'waiting', title: 'Waiting for you', counted: true },
      { id: 'working', title: 'Working', counted: true, rest: true },
      { id: 'closed', title: 'Closed', counted: false },
    ];
    function orderButton() {
      return S.orderButton({ prefs: order, onClick: (anchor) => deps.menu(anchor, L.menuItems(order, (next) => {
        order = next;
        if (current) L.save(orderKey(current), order);
        paintHead();
        paintFolder();
      })) });
    }
    function chatGroups() {
      return L.arrange(chats, order, {
        at: (c) => c.at, created: (c) => c.created, name: (c) => c.title || 'Chat', status: (c) => c.state,
        statuses: CHAT_STATES,
      });
    }
    function paintFolder() {
      if (frame.screen !== 'agent' || !current) return;
      const list = make('div', 'lex-section-list');
      if (archivedChats && archivedChats.length) list.appendChild(archivedRow(archivedChats.length));
      for (const g of chatGroups()) {
        if (!g.items.length) continue;
        if (g.title) list.appendChild(S.groupLabel(g.title, g.count));
        for (const c of g.items) list.appendChild(chatLine(c));
      }
      if (!chats.length && !(archivedChats && archivedChats.length)) {
        frame.body.replaceChildren(S.emptyState({ face: S.agentFace(current.key, { size: 48, quiet: true }), title: 'No chats yet',
          line: 'New chat below starts one.' }));
        return;
      }
      frame.body.replaceChildren(list);
      pick(deps.openKey ? deps.openKey() : null);
    }
    // The line of the chat open beside the folder (a wide window) stands picked.
    function pick(chatKey) {
      for (const r of frame.el.querySelectorAll('.lex-agent-chat')) {
        const main = r.querySelector('.lex-section-row-main');
        r.classList.toggle('is-picked', !!chatKey && !!main && main.dataset.id === chatKey);
      }
    }
    async function readFolder() {
      const a = current;
      if (!a) return;
      // The archive of the folder beside it: a base without it answers nothing, and the folder has no row «Archived».
      const [got, arch] = await Promise.all([
        deps.rpc('lex_agent_chats', { p_agent: a.key }),
        deps.rpc('lex_agent_archived', { p_agent: a.key }).catch(() => null),
      ]);
      if (!current || current.key !== a.key) return;
      chats = Array.isArray(got) ? got.filter((c) => c && c.chatKey) : [];
      archivedChats = Array.isArray(arch) ? arch.filter((c) => c && c.chatKey) : (archivedChats || []);
      const w = chats.find((c) => c.state === 'waiting' && c.last);
      if (w) waitWords.set(a.key, oneLine(w.last));
      paintFolder();
      paintArchived();
    }
    // ── the agent's own main screen (the contract «Scribe в Lex», p. 1) ─────────────────────────────────────────
    // The head: the name in the middle (the passport), Activity at the left, «Chats» at the right — the folder of its
    // task chats. The body: the blocks of place «main» (Scribe: the totals and the history), read from the base.
    function activityButton(a) {
      const b = S.button('lex-section-icon', null, () => openLog(a));
      b.appendChild(S.markSvg((S.MARKS.tool && S.MARKS.tool.activity) || CLOCK, 20, 2));
      b.title = 'Activity';
      b.setAttribute('aria-label', 'Activity: what the agent did');
      return b;
    }
    function mainHead(a) {
      return Object.assign({
        title: a.name || a.key,
        lead: activityButton(a),
        onTitle: () => openPassport(a),
        titleLabel: `${a.name || a.key}: the passport`,
        action: { icon: BUBBLE, label: 'Chats', ariaLabel: 'Chats with the agent', onClick: () => openFolder(a) },
      }, stateLine(a));
    }
    function paintMainHead() {
      if (frame.screen !== 'screen' || !current || typeof frame.setHead !== 'function') return;
      frame.setHead(mainHead(current));
    }
    function paintMain() {
      if (frame.screen !== 'screen' || !current) return;
      const ctl = screenOf(current);
      if (!ctl) return;
      ctl.paintMain(frame.body);
    }
    function openMain(a) {
      current = a;
      push({ id: 'screen', title: a.name || a.key, head: mainHead(a) });
      const body = frame.body;
      body.replaceChildren();
      const ctl = screenOf(a);
      if (!ctl) return;
      ctl.read().then(() => { if (frame.body === body) ctl.paintMain(body); })
        .catch((e) => { if (e && e.status) say(String(e.message || ''), true); else console.warn('[agents] screen:', e && e.message); });
    }

    function openFolder(a) {
      current = a;
      order = L.load(orderKey(a));
      chats = [];
      archivedChats = null;
      push({ id: 'agent', title: a.name || a.key, head: folderHead(a) });
      frame.body.replaceChildren();
      readFolder().catch((e) => say(`The chats did not come. ${(e && e.message) || ''}`.trim(), true));
    }

    // ── the journal «Activity» (board AgF2Log) ────────────────────────────────────────────────────────────────
    // What the agent did by itself, from the newest, by days (the line of a day, as in a chat). A line: the time, what it
    // did (the subject, or the word of the kind), under it «12 s · Opus 5.5» or «7 min · Opus 5.5», «Failed: …», «Skipped: …», «Running…» or
    // «Queued»; the bubble at the right begins a new chat about this line (AgAskRun). The next page comes when the end of
    // the list comes on the screen (next_before of the base, as it is).
    // How long a run took: under a minute in seconds («28 s»), from a minute in whole minutes («7 min»).
    function runTime(secs) {
      if (!Number.isFinite(secs) || secs <= 0) return '';
      return secs < 60 ? `${Math.max(1, Math.round(secs))} s` : `${Math.round(secs / 60)} min`;
    }
    function runSub(r) {
      const why = oneLine(r.reason);
      if (r.result === 'failed') return [make('span', 'lex-agent-run-failed', 'Failed:'), ` ${why}`];
      if (r.result === 'skipped') return [make('span', 'lex-agent-run-skipped', 'Skipped:'), ` ${why}`];
      if (r.result === 'running') return [S.agentState({ state: 'working', text: 'Running…' })];
      if (r.result === 'queued') return ['Queued'];
      return [[runTime(Number(r.duration)), runModel(r.model)].filter(Boolean).join(' · ')];
    }
    function runLine(a, r) {
      const time = make('span', 'lex-agent-run-time', hhmm(r.at));
      const sub = make('span', 'lex-agent-run-sub');
      sub.append(...runSub(r));
      const row = S.row({ id: r.id, title: actionWords(r) || 'Run', sub, wrap: true, lead: time, cls: 'lex-agent-run-main' });
      row.classList.add('lex-agent-run');
      row.dataset.at = r.at || '';
      const ask = S.button('lex-section-icon lex-agent-run-ask', null, () => deps.ask(a, { id: r.id, at: r.at, title: actionWords(r) || 'Run' }));
      ask.appendChild(S.markSvg(BUBBLE, 20, 2));
      ask.title = 'Ask about this';
      ask.setAttribute('aria-label', `Ask about this: ${actionWords(r)}`);
      row.appendChild(ask);
      return row;
    }
    // The journal painted into a body: a screen of the frame (a narrow window) or the frame beside the folder (aside).
    function logInto(host, a) {
      const list = make('div', 'lex-section-list lex-agents-runs');
      const end = make('div', 'lex-agents-runs-end');
      host.replaceChildren(list, end);
      let before = null;
      let done = false;
      let reading = false;
      let lastDay = '';
      const M = global.LexMessage;
      async function more() {
        if (reading || done || !host.isConnected) return;
        reading = true;
        try {
          const got = await deps.call({ op: 'runs', agent: a.key, ...(before ? { before } : {}), limit: 30 });
          const runs = Array.isArray(got && got.runs) ? got.runs.filter((r) => r && r.id) : [];
          for (const r of runs) {
            const day = M && M.dayOf ? M.dayOf(r.at) : '';
            if (day && day !== lastDay) { list.appendChild(M.dayLine(r.at)); lastDay = day; }
            list.appendChild(runLine(a, r));
          }
          before = (got && got.next_before) || null;
          done = !before || !runs.length;
          if (done && !list.childElementCount) host.replaceChildren(S.emptyState({ face: S.agentFace(a.key, { size: 48, quiet: true }), title: 'Nothing done yet' }));
        } catch (e) {
          if (e && e.status) say(String(e.message || ''));
          else console.warn('[agents] runs:', e && e.message);
        } finally { reading = false; }
        // The end still on the screen (a short page): one more.
        if (!done && end.isConnected && end.getBoundingClientRect().top < window.innerHeight) more();
      }
      if (typeof IntersectionObserver !== 'undefined') {
        const seen = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) more(); }, { root: null, rootMargin: '400px' });
        seen.observe(end);
      }
      return more();
    }
    // A press on «Activity»: a narrow window — a screen over the folder; a wide one — the frame beside it, in the place of
    // the chat (the window shows it: deps.onScreen('log-aside')).
    function openLog(a) {
      if (deps.wide && deps.wide()) {
        aside.setHead({ title: 'Activity', sub: a.name || a.key });
        aside.el.hidden = false;
        if (deps.onScreen) deps.onScreen('log-aside', a);
        logInto(aside.body, a);
        return;
      }
      push({ id: 'log', title: 'Activity', head: { title: 'Activity', sub: a.name || a.key } });
      logInto(frame.body, a);
    }
    // The journal beside the folder on a wide window: a frame of its own, without an arrow (the folder is on the left).
    const aside = S.createFrame({ title: 'Activity', cls: 'lex-agents lex-agents-log' });
    aside.el.hidden = true;
    function closeAside() {
      if (aside.el.hidden) return false;
      aside.el.hidden = true;
      aside.body.replaceChildren();
      return true;
    }

    // ── the passport (board AgPassport) ───────────────────────────────────────────────────────────────────────
    // The face 96, the name, the state; About (For, Wakes on, Reads, Writes); the settings: Text model, Notify me, Paused;
    // the ways to the Instruction and the Memory. A setting goes to the base (op settings) and the row shows what the base
    // answered; a refusal pops up with the base's words, the value stays as it was.
    function aboutOf(a) { return about.get(a.key) || {}; }
    function passportState(a) {
      const s = stateOf(a);
      const n = Number(a.waiting) || 0;
      if (n > 0 && s !== 'paused') return { text: 'Waiting for you', tone: 'is-wait' };
      if (s === 'working') return { text: 'Working' };
      if (s === 'paused') return { text: 'Paused' };
      if (s === 'failed') return { text: `Failed: ${oneLine(a.failed_reason)}`.trim(), tone: 'is-failed' };
      return { text: 'Idle' };
    }
    const listText = (v) => (Array.isArray(v) ? v.map(oneLine).filter(Boolean).join('; ') : oneLine(v));
    function aboutBlock(a, p) {
      const rows = [
        { caption: 'For', value: oneLine(p.goal || a.goal) || '—' },
        { caption: 'Wakes on', value: listText(p.wakes) || '—' },
        { caption: 'Reads', value: listText(p.reads) || '—' },
        { caption: 'Writes', value: listText(p.writes) || '—' },
      ];
      return S.aboutBlock('About', rows);
    }
    function paintPassport() {
      if (frame.screen !== 'passport' || !current) return;
      const a = current;
      const p = aboutOf(a);
      const merged = Object.assign({}, a, p.state ? { state: p.state } : {});
      const root = make('div', 'lex-agent-passport');
      const st = passportState(merged);
      const top = make('div', 'lex-agent-top');
      top.append(S.agentFace(a.key, { size: 96, name: a.name || a.key }), make('div', 'lex-agent-name', a.name || a.key),
        make('div', `lex-agent-state${st.tone ? ` ${st.tone}` : ''}`, st.text));
      root.append(top, aboutBlock(a, p));
      // The agent's own blocks of the card (Scribe: Model, Recording description, Keys on this Mac), after About.
      const ctl = screenOf(a);
      if (ctl) for (const n of ctl.cardBlocks()) root.appendChild(n);
      const model = { model: p.model || a.model, effort: p.effort || a.effort };
      // «Text model» only for an agent that has one (model_kind «none» gives model null: Scribe has recognizers).
      const textModel = !!model.model;
      const engine = p.engine || a.engine || null;
      const notify = p.notify || a.notify || 'all';
      const paused = p.paused != null ? !!p.paused : !!a.paused;
      const pauseMain = p.pause_main || a.pause_main || 'queue';
      const ins = p.instruction || null;
      const mem = Array.isArray(p.memory) ? p.memory : null;
      root.appendChild(S.settingsBlock([
        textModel ? S.settingRow({ id: 'model', title: 'Text model', menu: { value: modelLabel(model),
          onOpen: (anchor) => deps.pickModel(anchor, modelId(model), (id) => {
            const [, m, effort] = String(id).split(':');
            saveModel(a.key, m, effort);
          }) } }) : null,
        ...(engine ? [S.settingRow({ id: 'engine', title: 'Engine', menu: { value: engineLabel(engine),
          onOpen: (anchor) => deps.menu(anchor, ENGINES.map((x) => ({ label: x.label, checked: x.value === engine,
            onSelect: () => { saveEngine(a.key, x.value); } }))) } })] : []),
        S.settingRow({ id: 'notify', title: 'Notify me', note: 'What this agent may notify about', menu: {
          value: (NOTIFY.find((x) => x.value === notify) || NOTIFY[0]).label,
          onOpen: (anchor) => deps.menu(anchor, NOTIFY.map((x) => ({ label: x.label, note: x.note, checked: x.value === notify,
            onSelect: () => { if (x.value !== notify) save(a.key, { notify: x.value }); } }))),
        } }),
        S.settingRow({ id: 'paused', title: 'Paused', note: PAUSE_NOTE[pauseMain] || PAUSE_NOTE.queue, toggle: { on: paused,
          onChange: (on, input) => save(a.key, { paused: on }).then((ok) => { if (!ok && input) input.checked = !on; }) } }),
      ]));
      root.appendChild(S.settingsBlock([
        S.settingRow({ id: 'instruction', title: 'Instruction', go: { value: ins && ins.updated_at ? `Updated ${enDate(ins.updated_at)}` : (p.instruction === undefined ? '' : 'None'),
          onClick: () => openInstruction(a) } }),
        S.settingRow({ id: 'memory', title: 'Memory', go: { value: mem ? (mem.length ? `${mem.length} ${mem.length === 1 ? 'note' : 'notes'}` : 'No notes') : '',
          onClick: () => openMemory(a) } }),
      ]));
      const keep = frame.body.scrollTop;
      frame.body.replaceChildren(root);
      frame.body.scrollTop = keep;
    }
    async function readAbout(a) {
      let got;
      try { got = await deps.call({ op: 'about', agent: a.key }); } catch (e) { refused(e); return; }
      if (got && typeof got === 'object') about.set(a.key, got);
      paintPassport();
    }
    function openPassport(a) {
      current = byKey.get(a.key) || a;
      push({ id: 'passport', title: a.name || a.key, head: { title: '' } });
      paintPassport();
      readAbout(current).catch((e) => console.warn('[agents] about:', e && e.message));
      const ctl = screenOf(current);
      if (ctl) ctl.read().then(() => paintPassport()).catch((e) => console.warn('[agents] screen:', e && e.message));
    }
    // A setting to the base: true — the base took it, and the passport and the list show what it answered.
    async function save(key, patch) {
      let got;
      try {
        got = await deps.call({ op: 'settings', agent: key, ...patch });
      } catch (e) {
        deps.toast(`Not saved. ${(e && e.message) || ''}`.trim(), true);
        paintPassport();
        return false;
      }
      const fresh = {};
      for (const k of ['model', 'effort', 'engine', 'paused', 'paused_at', 'notify', 'can_pause', 'pause_main']) if (got && got[k] !== undefined) fresh[k] = got[k];
      const a = byKey.get(key);
      if (a) Object.assign(a, fresh);
      if (current && current.key === key && current !== a) Object.assign(current, fresh);
      if (about.has(key)) Object.assign(about.get(key), fresh);
      paintPassport();
      await readList().catch((e) => console.warn('[agents] list:', e && e.message));
      return true;
    }
    // The engine of an agent whose task chat is a session of Claude Code (26.11.2026; the base gives `engine` only then):
    // the subscription (the API key when its windows run out) or the API key alone. Only this screen of Gennady changes it.
    function saveEngine(key, engine) {
      const a = byKey.get(key);
      if (!ENGINES.some((x) => x.value === engine) || (a && a.engine === engine)) return Promise.resolve(false);
      return save(key, { engine }).then((ok) => {
        const b = byKey.get(key);
        if (ok && b) deps.toast(`${b.name || key}: ${engineLabel(b.engine)}`);
        return ok;
      });
    }
    function saveModel(key, model, effort) {
      if (!model) return Promise.resolve(false);
      return save(key, { model, ...(effort ? { effort } : {}) }).then((ok) => {
        const a = byKey.get(key);
        if (ok && a) deps.toast(`${a.name || key}: ${modelLabel(a)}`);
        return ok;
      });
    }

    // ── the instruction and the memory (boards AgInstruction, AgMemory): read only ────────────────────────────
    async function ensureAbout(a) {
      if (!about.has(a.key)) await readAbout(a);
      return aboutOf(a);
    }
    async function openInstruction(a) {
      const p0 = aboutOf(a);
      // Under «Instruction» (board AgInstruction, as the iPhone): the agent's name and the time of the last edit.
      const sub = (p) => [a.name || a.key, p.instruction && p.instruction.updated_at ? `updated ${enDate(p.instruction.updated_at, true)}` : ''].filter(Boolean).join(' · ');
      const body = push({ id: 'instruction', title: 'Instruction', head: { title: 'Instruction', sub: sub(p0) } });
      const p = await ensureAbout(a);
      if (frame.body !== body) return;
      if (typeof frame.setHead === 'function') frame.setHead({ title: 'Instruction', sub: sub(p) });
      const text = p.instruction && p.instruction.text ? String(p.instruction.text) : '';
      if (!text) { body.replaceChildren(S.emptyState({ section: 'agents', title: 'No instruction' })); return; }
      const box = make('div', 'lex-agent-doc');
      deps.markdown(box, text);
      body.replaceChildren(box);
    }
    async function openMemory(a) {
      const notes = (p) => (Array.isArray(p.memory) ? p.memory : null);
      const sub = (p) => {
        const m = notes(p);
        return [a.name || a.key, m ? (m.length ? `${m.length} ${m.length === 1 ? 'note' : 'notes'}` : 'No notes') : ''].filter(Boolean).join(' · ');
      };
      const body = push({ id: 'memory', title: 'Memory', head: { title: 'Memory', sub: sub(aboutOf(a)) } });
      const p = await ensureAbout(a);
      if (frame.body !== body) return;
      if (typeof frame.setHead === 'function') frame.setHead({ title: 'Memory', sub: sub(p) });
      const m = (notes(p) || []).slice();
      if (!m.length) { body.replaceChildren(S.emptyState({ section: 'agents', title: 'No notes' })); return; }
      // The main note first, then the newest.
      m.sort((x, y) => (y.main ? 1 : 0) - (x.main ? 1 : 0) || (Date.parse(y.updated_at || '') || 0) - (Date.parse(x.updated_at || '') || 0));
      const list = make('div', 'lex-section-list lex-agent-memory');
      for (const n of m) {
        list.appendChild(S.row({ title: oneLine(n.title) || 'Note', sub: oneLine(n.text || n.description), time: S.listTime(n.updated_at),
          wrap: true, subLines: 3, cls: 'lex-agent-note' }));
      }
      body.replaceChildren(list);
    }

    // The screen on top read again (a signal, the section shown again); a task chat on the screen reads itself.
    async function readScreen() {
      if (frame.screen === 'agent' || frame.screen === 'archived') await Promise.all([readFolder(), readList()]);
      else if (frame.screen === 'screen' && current && screenOf(current)) await Promise.all([screenOf(current).refresh(), readList()]);
      else await readList();
    }
    async function look(signal) {
      // An agent's own screen changed: only that screen reads again, the first page and the totals.
      if (signal && signal.event === 'agent_screen') {
        const key = signal.payload && signal.payload.agent;
        if (frame.isShown() && current && current.key === key && (frame.screen === 'screen' || frame.screen === 'passport')) {
          const ctl = screenOf(current);
          if (ctl) await ctl.refresh();
        }
        return;
      }
      if (deps.chatOpen()) {
        const ev = signal && signal.event;
        await deps.onChange(ev === 'folders' ? (signal.payload || null) : null);
      }
      if (frame.isShown()) await readScreen();
    }

    return {
      el: frame.el,
      // The frame of the journal beside the folder (a wide window): the window puts it in the place of the chat.
      aside: aside.el,
      closeAside,
      stopOpening: frame.stopOpening,
      // The section entered from its button: the list; back from a task chat (opts.back) — the screen it was left on.
      async show(opts) {
        if (!(opts && opts.back)) { frame.reset(); current = null; }
        frame.enter();
        told();
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
      // The agent's own main screen (right Cmd+H of Scribe, `agent_screen` of a notification): an agent without one —
      // its folder. → the agent.
      async enterScreen(key) {
        if (!byKey.has(key)) await readList().catch((e) => console.warn('[agents] list:', e && e.message));
        const a = byKey.get(key) || { key, name: key };
        frame.reset();
        if (a.screen && global.LexAgentScreen) openMain(a); else openFolder(a);
        return a;
      },
      agent: (key) => byKey.get(key) || null,
      // The agent of the screen on top: its folder, its journal, its passport, its instruction or memory; null on the list.
      // The capsule «New chat» on these screens begins a chat with it (wc-app.js openQuick → newAgentChat).
      currentAgent: () => (current ? { key: current.key, name: current.name || current.key } : null),
      // The screen on top: home, screen, agent, log, passport, instruction, memory.
      get screen() { return frame.screen; },
      // The passport of an agent from the head of its task chat (the chat leaves, the passport stands over its folder).
      passport(key) {
        const a = byKey.get(key) || (current && current.key === key ? current : { key, name: key });
        if (!current || current.key !== key || frame.screen === 'home') {
          frame.reset();
          if (a.screen && global.LexAgentScreen) openMain(a); else openFolder(a);
        } else while (frame.screen !== 'agent' && frame.screen !== 'screen' && frame.screen !== 'home') frame.pop();
        openPassport(a);
      },
      // The open chat changed (a wide window): its line in the folder stands picked.
      pick,
      // The arrow of the window as the screens of the section want it (a wide window: the folder beside the chat).
      arrow: () => frame.enter(),
      // The agent's model (the passport, «+ → Text model» in its chats): to the base, the list and the passport show it.
      saveModel,
      saveEngine,
      readList,
    };
  }

  global.WcAgents = { createSection, modelId, modelLabel, stateOf, sortAgents, KIND_WORDS, NOTIFY, PAUSE_NOTE, ENGINES, engineChoice };
})(typeof window !== 'undefined' ? window : globalThis);
