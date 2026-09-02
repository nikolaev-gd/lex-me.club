// webchat/wc-sidebar.js — the list of conversations.
//
// Rename is inline rather than a modal: renaming is the one list action people
// do repeatedly, and a dialog for every one of them is three extra clicks. The
// per-row menu holds it too, because an inline editor with no visible entry
// point is not discoverable and is unreachable without a pointer.
//
// Имя беседы приходит с сервера и считается там один раз. Пока его нет,
// строка показывает нейтральную заглушку и перерисовывается, когда имя
// доедет. Первой фразой беседы заглушка быть не может: в строке списка нет
// содержимого переписки вовсе (docs/PLAN-CHAT-LIST.md, решение 5).
//
// СПИСОК ПРИХОДИТ ПОРЦИЯМИ. Дотянул до низа — просим следующую. Порог берётся
// с запасом в пол-экрана, чтобы следующая порция успевала приехать до того,
// как человек упрётся в конец.
(function (global) {
  'use strict';

  const { el, icon, iconBtn, menu, confirm, prompt } = WcUI;

  let elList, elSidebar, elRoot, elScrim;
  let hooks = {};
  let items = [];
  let activeId = null;
  let renamingId = null;
  let listError = null;   // список не прочитался — это НЕ пустой список
  let listDone = false;   // порций больше нет (или дозагрузка остановлена отказом)

  const DAY = 86400e3;
  function groupOf(ts) {
    const age = Date.now() - (ts || 0);
    if (age < DAY) return 'Today';
    if (age < 7 * DAY) return 'This week';
    if (age < 30 * DAY) return 'This month';
    return 'Earlier';
  }

  const displayTitle = WcUI.conversationTitle;

  async function doRename(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    renamingId = id;
    render();
    const input = elList.querySelector('.wc-conv-rename');
    if (!input) {
      // No inline field to focus (the row is not on screen) — fall back to the
      // dialog rather than leaving the person with nothing.
      renamingId = null;
      const next = await prompt('Chat name', (it.title || '').trim(), { okText: 'Rename' });
      if (next !== null) await hooks.onRename(id, next);
      return;
    }
    input.focus();
    input.select();
  }

  async function commitRename(id, value) {
    renamingId = null;
    const it = items.find((x) => x.id === id);
    const next = String(value || '').trim().slice(0, 120);
    if (it && next === (it.title || '').trim()) { render(); return; }
    await hooks.onRename(id, next);
  }

  function rowMenu(anchor, it) {
    menu(anchor, [
      { label: 'Rename', icon: 'pencil', onSelect: () => doRename(it.id) },
      { separator: true },
      {
        label: 'Delete',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const t = displayTitle(it);
          const ok = await confirm(
            'Delete this chat?',
            'It disappears from the list. The conversation itself stays in the cloud — nothing is lost there.'
              + (t.untitled ? '' : '\n\n' + t.text),
            { okText: 'Delete', danger: true }
          );
          if (ok) await hooks.onDelete(it.id);
        },
      },
    ]);
  }

  function row(it) {
    if (it.id === renamingId) {
      const input = el('input.wc-conv-rename', {
        type: 'text',
        value: (it.title || '').trim(),
        maxlength: 120,
        placeholder: 'Name',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitRename(it.id, e.target.value); }
          else if (e.key === 'Escape') { e.preventDefault(); renamingId = null; render(); }
        },
        // Blur commits rather than cancels: clicking away from a field you
        // just typed into means "keep it" to almost everybody.
        onblur: (e) => { if (renamingId === it.id) commitRename(it.id, e.target.value); },
      });
      return el('.wc-conv', {}, [input]);
    }

    const t = displayTitle(it);
    const more = iconBtn('dots', 'More', (e) => {
      e.stopPropagation();
      rowMenu(e.currentTarget, it);
    }, 'wc-conv-more');

    return el('.wc-conv' + (it.id === activeId ? '.is-active' : ''), {
      role: 'listitem',
      tabindex: '0',
      onclick: () => hooks.onOpen(it.id),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hooks.onOpen(it.id); }
        else if (e.key === 'F2') { e.preventDefault(); doRename(it.id); }
      },
      // A long press is how a touch device reaches a hover menu. Kept
      // alongside the visible button, not instead of it.
      oncontextmenu: (e) => { e.preventDefault(); rowMenu(more, it); },
    }, [
      el('.wc-conv-title' + (t.untitled ? '.is-untitled' : ''), { text: t.text, title: t.text }),
      more,
    ]);
  }

  // Отказ сети — ОТДЕЛЬНОЕ состояние от пустого списка, и это не педантизм:
  // «No chats yet.» на месте не прочитанного списка — сообщение о том, что у
  // человека нет бесед, то есть неправда о его собственных данных, и повторить
  // попытку ему нечем. Поэтому у отказа своя строка и своя кнопка.
  function errorRow(partial) {
    return el('.wc-convs-error', {}, [
      el('div', { text: partial ? 'Could not load more chats.' : 'Could not load your chats.' }),
      el('button.wc-convs-retry', {
        type: 'button',
        text: 'Retry',
        onclick: () => { if (hooks.onRetry) hooks.onRetry(); },
      }),
    ]);
  }

  function render() {
    if (!items.length) {
      elList.replaceChildren(listError ? errorRow(false) : el('.wc-convs-empty', { text: 'No chats yet.' }));
      return;
    }
    const nodes = [];
    let lastGroup = null;
    items.forEach((it) => {
      const g = groupOf(it.updatedAt);
      if (g !== lastGroup) { nodes.push(el('.wc-convs-group', { text: g })); lastGroup = g; }
      nodes.push(row(it));
    });
    // Часть списка пришла, а продолжение отвалилось: показанное остаётся на
    // месте, а обрыв назван словами внизу — молча оборванный список выглядел
    // бы как конец списка.
    if (listError) nodes.push(errorRow(true));
    elList.replaceChildren(...nodes);
  }

  // ── Дозагрузка по прокрутке ───────────────────────────────────────────────
  //
  // ⚠ ТРИ УСЛОВИЯ, И КАЖДОЕ ОБЯЗАТЕЛЬНО. `listDone` — список кончился (его же
  // ставит отказ, чтобы прокрутка не долбила упавший сервер). `hooks.onLoadMore`
  // сам держит замок «один запрос за раз»: событие прокрутки приходит на каждый
  // кадр, и без замка быстрый мах послал бы пять запросов с одним курсором.
  // Порог в пол-экрана — чтобы порция успевала приехать до упора в конец.
  function onScroll() {
    if (listDone || !hooks.onLoadMore) return;
    const gap = elList.scrollHeight - elList.scrollTop - elList.clientHeight;
    if (gap < elList.clientHeight * 0.5) hooks.onLoadMore();
  }

  // ── Жест ─────────────────────────────────────────────────────────────────
  //
  // Шторка обязана ходить ЗА ПАЛЬЦЕМ, а не появляться по нажатию. Разница не
  // косметическая: пока палец на экране, человек видит, сколько он вытянул и
  // что будет, если отпустить, — и может передумать на полпути. Кнопка такого
  // не даёт.
  //
  // Два входа: свайп от ЛЕВОГО КРАЯ открывает (системный жест «назад» на iOS
  // начинается там же, и приложение обязано вести себя так же), протяжка по
  // самой шторке закрывает.
  //
  // Решение на отпускании — по расстоянию ИЛИ по скорости. Только расстояние —
  // и быстрый короткий флик, которым обычно и закрывают, не срабатывает;
  // только скорость — и медленная уверенная протяжка на весь экран не
  // срабатывает тоже.
  const EDGE_PX = 28;        // ширина полосы у края, с которой начинается жест
  const FLICK_VPX = 0.45;    // px/мс — порог «это был бросок, а не перетаскивание»

  function installDrag() {
    let active = false;
    let opening = false;
    let startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0;
    let width = 1;
    let decided = false;   // поняли ли, что это горизонтальный жест

    const setShift = (px) => {
      elSidebar.style.transition = 'none';
      elSidebar.style.transform = 'translateX(' + px + 'px)';
      // Затемнение набирается пропорционально вытянутому — иначе оно
      // появлялось бы скачком в конце.
      elScrim.hidden = false;
      elScrim.style.opacity = String(Math.max(0, Math.min(1, 1 + px / width)));
    };

    const release = (open) => {
      elSidebar.style.transition = '';
      elSidebar.style.transform = '';
      elScrim.style.opacity = '';
      WcSidebar.toggle(open);
    };

    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;         // мышью тянуть нечего
      const closed = elRoot.classList.contains('is-sidebar-collapsed');
      if (closed && e.clientX > EDGE_PX) return;
      if (!closed && !elSidebar.contains(e.target) && e.target !== elScrim) return;
      active = true; decided = false; opening = closed;
      width = elSidebar.getBoundingClientRect().width || 1;
      startX = lastX = e.clientX; startY = e.clientY; lastT = e.timeStamp; vx = 0;
    }, { passive: true });

    document.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!decided) {
        // Пока не решили — не мешаем: вертикальное движение это прокрутка
        // списка, и перехватывать её нельзя.
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { active = false; return; }
        if (Math.abs(dx) < 8) return;
        decided = true;
      }
      const dt = Math.max(1, e.timeStamp - lastT);
      vx = (e.clientX - lastX) / dt;
      lastX = e.clientX; lastT = e.timeStamp;
      // Открываем: от -width к 0. Закрываем: от 0 к -width.
      const shift = opening
        ? Math.min(0, -width + Math.max(0, dx))
        : Math.max(-width, Math.min(0, dx));
      setShift(shift);
    }, { passive: true });

    const finish = (e) => {
      if (!active) return;
      active = false;
      if (!decided) return;                 // жеста не было — состояние не трогаем
      const dx = (e && e.clientX != null ? e.clientX : lastX) - startX;
      const far = Math.abs(dx) > width * 0.4;
      const flick = Math.abs(vx) > FLICK_VPX;
      const forward = opening ? (dx > 0) : (dx < 0);
      const commit = (far || flick) && forward;
      release(opening ? commit : !commit);
    };
    document.addEventListener('pointerup', finish, { passive: true });
    document.addEventListener('pointercancel', finish, { passive: true });
  }

  const WcSidebar = {
    init(h) {
      hooks = h;
      elList = document.getElementById('wc-convs');
      elList.addEventListener('scroll', onScroll, { passive: true });
      elSidebar = document.getElementById('wc-sidebar');
      elRoot = document.getElementById('wc-root');
      elScrim = document.getElementById('wc-scrim');
      installDrag();

      document.getElementById('wc-new-chat').addEventListener('click', () => {
        hooks.onNew();
        WcSidebar.close();
      });
      document.getElementById('wc-sidebar-close').addEventListener('click', () => WcSidebar.toggle(false));
      document.getElementById('wc-sidebar-open').addEventListener('click', () => WcSidebar.toggle(true));
      elScrim.addEventListener('click', () => WcSidebar.toggle(false));
    },

    setItems(next, active, meta) {
      items = (next || []).slice();
      activeId = active === undefined ? activeId : active;
      if (meta) { listError = meta.error || null; listDone = !!meta.done; }
      render();
      // Порция пришла, а список всё ещё короче окна — значит прокрутке нечем
      // сработать, и следующая порция не придёт никогда. Спрашиваем сами.
      if (!listDone && elList && elList.scrollHeight <= elList.clientHeight) onScroll();
    },

    setActive(id) {
      activeId = id;
      render();
    },

    toggle(open) {
      const collapsed = elRoot.classList.contains('is-sidebar-collapsed');
      const want = open === undefined ? collapsed : open;
      elRoot.classList.toggle('is-sidebar-collapsed', !want);
      // Щелчок под пальцем на ЗАЩЁЛКИВАНИИ — в тот кадр, где меняется класс и
      // начинается доводка. Не во время протяжки: `pointermove` приходит на
      // каждый кадр, и отклик там был бы не щелчком, а дребезгом.
      //
      // Условие «состояние изменилось» — не перестраховка. Через эту точку
      // проходит и `close()`, который зовут открытие беседы и «новый чат»; там
      // шторка чаще всего УЖЕ закрыта, и безусловный отклик означал бы щелчок
      // на каждой отправке. Цена условия: брошенная на полпути протяжка
      // отщёлкивает назад молча — состояние-то не менялось.
      if (want !== !collapsed) WcHaptics.press();
      // The drawer covers the thread at EVERY width now, so the scrim that
      // catches the tap-to-close is not a phone-only thing any more. It used
      // to be gated on .is-narrow; with the sidebar-as-column gone, that gate
      // would have left a desktop drawer with no way to dismiss it except the
      // hamburger.
      elScrim.hidden = !want;
      // Единая точка для решения про клавиатуру/курсор в поле ввода — что
      // кнопка, что жест (installDrag выше) заканчиваются здесь, и оба пути
      // обязаны решаться одинаково (wc-app.js: onSidebarToggle).
      if (hooks.onToggle) hooks.onToggle(want);
    },

    // Any action that moves the reader into the conversation closes the
    // drawer — it is lying over what they just asked to look at.
    close() { WcSidebar.toggle(false); },

    startRename(id) { return doRename(id); },
  };

  global.WcSidebar = WcSidebar;
})(typeof self !== 'undefined' ? self : globalThis);
