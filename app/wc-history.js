// webchat/wc-history.js — беседы: как читается их список, как открывается одна
// из них и как в неё дописываются реплики.
//
// ── СПИСОК СОБИРАЕТ СЕРВЕР, А НЕ ЭТОТ ФАЙЛ ──────────────────────────────────
// Раньше здесь лежала вторая реализация договора: файл сам решал, что считать
// беседой (classifyKey), сам вычитывал ВСЕ реплики аккаунта одним запросом и
// группировал их в список, сам доставал первую фразу каждой безымянной беседы
// и держал её в кэше. То же самое, по-своему, делали расширение и айфон — три
// реализации, которые расходились молча и упирались в предел 1000 строк.
//
// Теперь список — одна короткая строка на беседу — приходит из
// public.list_chats порциями по курсору (supabase/migrations/list_chats_rpc.sql).
// Ни превью, ни текста реплик в нём нет: поверхностям больше нечего вычислять,
// а значит и расходиться нечему. Переименование и скрытие ушли туда же — в
// rename_chat и set_chat_hidden; клиентских прав записи на public.chats нет
// вовсе, и подделать порядок списка или чужое имя нечем.
//
// ЧТО ОСТАЛОСЬ ЗА ЭТИМ ФАЙЛОМ: ОДНА беседа — её реплики, её ветки заготовок,
// дозапись в неё — и заведение строки сеанса. Это про содержимое, а не про
// список, и сервер этого на себя не брал.
//
// ── Имя беседы ──────────────────────────────────────────────────────────────
// Имя считается на сервере ОДИН РАЗ и там же хранится (docs/PLAN-CHAT-LIST.md,
// решение 2). Клиент его не придумывает: он только просит посчитать
// (`requestTitle`) для тех строк списка, что пришли с `title_pending`.
(function (global) {
  'use strict';

  const TAG = '[wc-history]';
  const A = () => global.LexWebAuth;

  // ── Ключ беседы ──────────────────────────────────────────────────────────
  //
  // ЧТО СЧИТАЕТСЯ беседой, решает база и решает ОДИН РАЗ, при записи реплики
  // (chats_table.sql: lex_chat_key_kind, lex_chat_parent_key). Здесь этого
  // разбора больше нет — он и был той второй реализацией. Осталось ровно то,
  // что нужно, чтобы ОТКРЫТЬ беседу и продолжить её.

  // Беседа, начатая основным чатом. Число после префикса — public.sessions.id,
  // платёжный сеанс; поэтому ключ нельзя отчеканить раньше первого сообщения.
  const STANDALONE_PREFIX = '__lex_standalone__';

  const keyForSession = (sessionId) => STANDALONE_PREFIX + sessionId;

  // Номер сеанса из ключа. Читается из САМОГО ключа, а не через разбор вида
  // беседы: открытая беседа обязана прикрепиться к своему сеансу, иначе
  // следующее сообщение уедет в новый и лента разорвётся надвое.
  function sessionIdOfKey(id) {
    if (typeof id !== 'string' || id.indexOf(STANDALONE_PREFIX) !== 0) return null;
    const tail = id.slice(STANDALONE_PREFIX.length);
    return /^\d+$/.test(tail) ? Number(tail) : null;
  }

  // ── Чем «занята» беседа: страница или видео ──────────────────────────────
  //
  // ВИД БЕСЕДЫ ПРИХОДИТ СТРОКОЙ СПИСКА, а не выводится здесь из формы ключа.
  // Раньше выводился — и это было опасно ровно тем, чем опасен любой
  // догадывающийся классификатор: ключ, не похожий ни на что знакомое,
  // объявлялся видео, и интерфейс сочинял для него адрес youtube.com/watch.
  // `hint` — это `kind` и `attachment_url` из list_chats, то есть ответ
  // сервера. Подсказки нет — привязки нет тоже: беседа без строки в списке
  // только что заведена, и привязки у неё физически ещё не бывает.
  //
  // Строка сеанса читается ТОЛЬКО ради заголовка страницы: адрес уже пришёл со
  // списком, а названия в нём нет. Это один запрос на ОТКРЫТУЮ беседу, а не на
  // каждую строку списка, — та цена, из-за которой список уехал на сервер,
  // здесь не платится.
  async function attachmentOf(key, hint) {
    const kind = hint && hint.kind;
    if (kind === 'video') {
      const videoId = String(key).slice(0, 11);
      return {
        kind: 'video',
        videoId,
        url: (hint && hint.url) || 'https://www.youtube.com/watch?v=' + videoId,
        title: '',
      };
    }
    if (kind !== 'page') return null;
    const sid = sessionIdOfKey(key);
    const fallback = (hint && hint.url) ? { kind: 'page', url: hint.url, title: '' } : null;
    if (sid == null) return fallback;
    let row = null;
    try {
      const rows = await get('/rest/v1/sessions?select=page_url,page_url_full,page_title&id=eq.'
        + encodeURIComponent(sid));
      row = Array.isArray(rows) ? rows[0] : null;
    } catch (_) {
      // Заголовок не прочитался — показываем адрес, который уже есть. Полоска
      // без названия лучше отсутствующей полоски.
      return fallback;
    }
    // Ссылка ведёт по ПОЛНОМУ адресу (page_url_full.sql). `page_url`
    // нормализован — он ключ поиска, и у приложения, адресующего документ
    // после '#', указывает на само приложение, а не на документ: беседа про
    // письмо уводила бы в ящик. У бесед до той миграции полного адреса нет.
    const url = (row && (row.page_url_full || row.page_url)) || (hint && hint.url) || '';
    if (!url) return null;
    return { kind: 'page', url, title: (row && row.page_title) || '' };
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  function accountId() {
    const s = A().session();
    return (s && s.user && s.user.id) || null;
  }

  async function rest(path, init) {
    const token = await A().validToken();
    if (!token) throw new Error('no valid session');
    const resp = await fetch(A().supabaseUrl() + path, Object.assign({}, init, {
      headers: Object.assign({
        apikey: A().anonKey(),
        Authorization: 'Bearer ' + token,
      }, (init && init.headers) || {}),
    }));
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + path.split('?')[0] + ' ' + body.slice(0, 160));
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  const get = (path) => rest(path);

  function post(path, body, prefer) {
    return rest(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, prefer ? { Prefer: prefer } : {}),
      body: JSON.stringify(body),
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  // Not optional bookkeeping: llm-proxy refuses a paid call whose meta carries
  // no session id ('no_session'), so a conversation without a row here cannot
  // talk to the teacher at all. Same insert the extension makes, with
  // session_kind 'standalone' — this page IS the standalone chat.
  // ── Откуда пришла беседа ─────────────────────────────────────────────────
  //
  // Одна и та же страница живёт вкладкой в браузере, окном программы на Маке и
  // приложением на айфоне, и в базе они обязаны различаться: «на телефоне
  // отвечает не так» и «в программе на Маке отвечает не так» — разные жалобы.
  //
  // Спрашиваем ОБОЛОЧКУ, а не браузер. `window.__lexShell` — пометка, которую
  // каждая ставит сама, до первой строчки страницы
  // (ios/LexChat/LexChat/ShellBridge.swift, macos/Sources/LexShell/ShellBridge.swift);
  // её же читает lex-composer-input.js, решая, что делает Enter. Угадывать по
  // строке браузера нельзя: WebKit внутри обеих оболочек один и тот же.
  //
  // ЧЕМ БЫЛО РАНЬШЕ и почему это врало. Раньше здесь спрашивалось «есть ли
  // вокруг мост с именем lex*» — а такой мост ставят ОБЕ оболочки (GoogleAuth
  // называется `lexauth` и там, и там). Поэтому Мак писался в базу как 'ios', и
  // отличить его было нечем. Проверка по мосту оставлена запасной: она
  // отвечает хотя бы «это оболочка, а не браузер», если пометка не доехала.
  const SHELL_PLATFORMS = { ios: 'ios', macos: 'macos' };
  function originOfThisClient() {
    try {
      const shell = global.__lexShell;
      const p = shell && shell.platform ? SHELL_PLATFORMS[String(shell.platform)] : null;
      if (p) return p;
      const h = global.webkit && global.webkit.messageHandlers;
      if (h && (h.lexauth || h.lexhaptics)) return 'ios';
    } catch (_) {}
    return 'web';
  }

  // Есть ли в базе колонка `origin` (supabase/migrations/session_origin.sql).
  //
  // Домовое правило требует катить миграцию РАНЬШЕ клиента, потому что клиент,
  // пишущий неизвестную колонку, получает отказ вставки — а без строки сеанса
  // беседа вообще не может говорить с учителем (llm-proxy отбивает платный
  // вызов как 'no_session'). Здесь порядок не важен ни в какую сторону: первый
  // отказ ИМЕННО по неизвестной колонке снимает поле и повторяет вставку.
  //
  // Признак живёт В ПАМЯТИ и только тут. В хранилище ему нельзя: он пережил бы
  // применение миграции, и origin остался бы пустым навсегда, ничем себя не
  // выдав. Перезагрузка страницы — и мы снова пробуем как следует.
  let originColumnMissing = false;
  // Чем помечать беседы этой загрузки. null — «спросить оболочку»; строка
  // появляется только после отказа по значению (см. isBadOriginValue) и живёт
  // ровно до перезагрузки страницы, по той же причине, что и признак выше.
  let originValue = null;

  // Отказ по неизвестной колонке — и ТОЛЬКО он. PostgREST отвечает PGRST204,
  // Postgres — 42703, и оба называют колонку. Ловить «любой 400» нельзя:
  // отказом на 400 отвечают и ограничитель частоты, и RLS, и молчаливый
  // повтор спрятал бы настоящую поломку.
  function isUnknownOriginColumn(err) {
    const s = String((err && err.message) || err || '');
    if (!/origin/i.test(s)) return false;
    return /PGRST204/.test(s) || /42703/.test(s)
      || /column .*origin.* does not exist/i.test(s)
      || /could not find the 'origin' column/i.test(s);
  }

  // Колонка есть, а ЗНАЧЕНИЯ она не знает: 'macos' появился в перечне
  // 2026-08-23, и база, где миграция ещё старая, отобьёт вставку нарушением
  // CHECK — код 23514, имя ограничения в тексте отказа. Отдельный случай от
  // неизвестной колонки: там снимается поле целиком, здесь достаточно написать
  // 'web' — беседа с Мака попадёт в общую кучу с браузером, что было правдой
  // до этой правки и уж точно лучше, чем молчащий чат. Без этой ветки цена
  // ошибки — весь продукт на Маке: нет строки сеанса → llm-proxy отбивает
  // платный вызов как 'no_session'.
  function isBadOriginValue(err) {
    const s = String((err && err.message) || err || '');
    return /23514/.test(s) && /sessions_origin_check/i.test(s);
  }

  async function createSession() {
    const account = accountId();
    if (!account) throw new Error('createSession: not signed in');
    const base = {
      account_id: account,
      // NOT the account: `user_id` is the DEVICE, a text column holding a uuid,
      // minted once per browser and NOT NULL. The extension keeps the same
      // notion under storage key 'user_id' (user-id.js). Leaving it out is a
      // 23502 from Postgres, which is how this was found.
      user_id: await deviceIdOnce(),
      session_kind: 'standalone',
      // The column is named extension_version and now carries a web build
      // stamp too. Renaming it would break every already-installed extension
      // writing to the same table.
      extension_version: global.WC_VERSION || 'webchat-dev',
    };

    let rows;
    if (originColumnMissing) {
      rows = await post('/rest/v1/sessions', [base], 'return=representation');
    } else {
      try {
        rows = await post('/rest/v1/sessions',
          [Object.assign({ origin: originValue || originOfThisClient() }, base)], 'return=representation');
      } catch (err) {
        if (isBadOriginValue(err)) {
          // База со старым перечнем. Один раз за загрузку переходим на 'web' и
          // повторяем — см. isBadOriginValue выше.
          originValue = 'web';
          console.warn(TAG, 'sessions.origin не знает значения этой оболочки — миграция session_origin.sql старее клиента; пишу беседы как web');
          rows = await post('/rest/v1/sessions',
            [Object.assign({ origin: originValue }, base)], 'return=representation');
        } else {
          if (!isUnknownOriginColumn(err)) throw err;
          originColumnMissing = true;
          console.warn(TAG, 'sessions.origin отсутствует — миграция session_origin.sql не применена; пишу беседы без пометки источника');
          rows = await post('/rest/v1/sessions', [base], 'return=representation');
        }
      }
    }

    const id = Array.isArray(rows) ? (rows[0] && rows[0].id) : null;
    if (id == null) throw new Error('createSession: no session row returned');
    return id;
  }

  // ── Список, переименование, скрытие — всё это делает сервер ──────────────
  //
  // ПОЧЕМУ ФУНКЦИЯ БАЗЫ, А НЕ ЧТЕНИЕ ТАБЛИЦЫ. Постраничности нужен ПОСТРОЧНЫЙ
  // разбор пары (last_at, id); PostgREST умеет только поколоночные условия, а
  // на совпадающих `last_at` это просто неверно — обход либо зациклится, либо
  // проглотит пачку строк. И предел порции обязан ставить сервер, а не клиент.
  //
  // КУРСОР НЕПРОЗРАЧЕН: клиент возвращает пару последней отданной строки как
  // есть и не разбирает её. Номер страницы здесь не годится — беседа,
  // получившая новую реплику, прыгает наверх, и вторая страница повторила бы
  // строку первой.
  const LIST_PAGE = 30;

  async function listChats(cursor) {
    const body = { p_limit: LIST_PAGE };
    if (cursor && cursor.lastAt) {
      body.p_cursor_last_at = cursor.lastAt;
      body.p_cursor_id = cursor.cursorId;
    }
    const rows = (await post('/rest/v1/rpc/list_chats', body)) || [];
    const items = rows.map((r) => ({
      id: r.chat_key,
      kind: r.kind,
      title: r.title || '',
      // Признак, а не пустая строка: заглушку надо рисовать ИМЕННО как
      // заглушку, иначе она станет именем, которого человек не выбирал.
      titlePending: !!r.title_pending,
      attachmentUrl: r.attachment_url || '',
      updatedAt: Date.parse(r.last_at) || 0,
      turnCount: r.turn_count || 0,
    }));
    const tail = rows[rows.length - 1];
    return {
      items,
      cursor: tail ? { lastAt: tail.last_at, cursorId: tail.cursor_id } : null,
      // «Пришло меньше, чем просили» — единственный честный признак конца.
      // Поэтому предел передаётся ЯВНО: положись мы на умолчание сервера,
      // сравнивать было бы не с чем, и прокрутка дёргала бы сервер без конца.
      done: rows.length < LIST_PAGE,
    };
  }

  // Пустая строка сбрасывает название (сервер кладёт NULL). Длину режет тоже
  // сервер — 200 знаков; решать это не клиенту.
  const renameChat = (chatKey, title) =>
    post('/rest/v1/rpc/rename_chat', { p_chat_key: chatKey, p_title: title });

  // Скрытие, а не удаление: строки в public.video_chat_turns не трогаются
  // никогда. И оно теперь ОБЩЕЕ для всех устройств, а не своё у каждого, —
  // беседа, убранная здесь, исчезает и в расширении, и на телефоне.
  const setChatHidden = (chatKey, hidden) =>
    post('/rest/v1/rpc/set_chat_hidden', { p_chat_key: chatKey, p_hidden: !!hidden });

  // ── Попросить сервер придумать имя ───────────────────────────────────────
  //
  // Ленивый путь: безымянная беседа получает имя при первом показе в шторке.
  // Считает его llm-proxy — там же, где гейт баланса, цена из public.models и
  // строка в public.calls. Клиент имён не придумывает и мимо гейта не платит:
  // это ровно то, что решение 3 забирает у трёх поверхностей.
  //
  // ⚠ ОТКАЗ НЕ ИМЕЕТ ПРАВА РОНЯТЬ СПИСОК. Это ОТДЕЛЬНЫЙ запрос, не часть
  // list_chats, поэтому мёртвый поставщик стоит серой заглушки, а не пустой
  // шторки. Отсюда ни одного `throw`: любая беда — это `null`, то есть
  // «имени пока нет», и список продолжает жить.
  async function requestTitle(chatKey) {
    const token = await A().validToken();
    if (!token) return null;
    try {
      const resp = await fetch(A().supabaseUrl() + '/functions/v1/llm-proxy/title', {
        method: 'POST',
        headers: {
          apikey: A().anonKey(),
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chatKey }),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    }
  }

  // ── One conversation ─────────────────────────────────────────────────────
  // Ordered by authored_at then turn_uid — NOT by seq. The client stopped
  // writing seq (its NOT NULL was dropped in a migration), so ordering by it
  // would put every recent turn in an arbitrary place.
  async function turns(videoId) {
    const rows = await get('/rest/v1/video_chat_turns'
      + '?select=role,content,turn_uid,authored_at,created_at,deleted_at'
      + '&video_id=eq.' + encodeURIComponent(videoId)
      + '&order=authored_at.asc,turn_uid.asc');
    return (rows || []).filter(keepRow).map(toTurn);
  }

  // Время авторства идёт НАРУЖУ вместе с репликой — оно нужно тому, кто сшивает
  // урок с ветками заготовок в одну ленту (wc-backend.js). Внутри одного ключа
  // порядок задаёт сам запрос, между ключами задать его нечем, кроме этого поля.
  // Фильтр СИДОВ снят вместе с ними. Он искал реплики, начинающиеся с
  // '[lex-context]' / '[lex-page]' / '[lex-transcript]' / '[lex-seed]', —
  // а на этой поверхности их не пишет никто (проверено grep'ом по webchat/ и
  // web/: строки встречались только в самом фильтре). В облаке сидов тоже нет
  // ни одного (docs/PLAN-CHAT-LIST.md §Д). То есть фильтр работал против
  // пустоты; сервер его к себе намеренно не взял, и держать его здесь значило
  // бы оставить кусок той самой второй реализации.
  const keepRow = (r) => !r.deleted_at;
  const toTurn = (r) => ({
    role: r.role,
    text: r.content || '',
    uid: r.turn_uid || null,
    authoredAt: r.authored_at || r.created_at || null,
  });

  // ── Переписки ЗАГОТОВОК одного чата ──────────────────────────────────────
  //
  // Ход через заготовку живёт своей веткой — ключ '__lex_action__<чат>__<слот>'
  // (lex-action-branch.js). Веток у чата столько, сколько заготовок в нём
  // трогали, и вперёд их список неизвестен: перечисляем ХРАНИЛИЩЕ, а не список
  // заготовок — ровно так же, как расширение (chat-surface.js
  // actionBranchPrefixOfChat). Удалённая заготовка от этого не уносит с собой
  // сказанное, и свежезагруженной странице не нужно дожидаться каталога.
  //
  // ⚠️ ОТБОР ИДЁТ В ДВА ШАГА, И ВТОРОЙ ОБЯЗАТЕЛЕН. В SQL LIKE подчёркивание —
  // это подстановочный знак «любой один символ», а в нашем префиксе их девять.
  // Значит запрос отбирает ШИРЕ, чем надо, и сузить его до точного совпадения
  // здесь нечем (ESCAPE PostgREST не даёт). Поэтому запрос только сокращает
  // выборку, а решает — actionBranchBelongsTo: тот же самый разбор, каким
  // расширение решает, чья это ветка. Без него в ленту чата попали бы ходы
  // ДРУГОГО чата, чей ключ отличается только знаком препинания.
  async function actionBranchTurns(prefix) {
    if (typeof prefix !== 'string' || !prefix) return [];
    const rows = await get('/rest/v1/video_chat_turns'
      + '?select=video_id,role,content,turn_uid,authored_at,created_at,deleted_at'
      + '&video_id=like.' + encodeURIComponent(prefix + '*')
      + '&order=authored_at.asc,turn_uid.asc');
    const AB = global.LexActionBranch;
    return (rows || [])
      .filter((r) => AB.actionBranchBelongsTo(r.video_id, prefix))
      .filter(keepRow)
      .map((r) => Object.assign(toTurn(r), { branchKey: r.video_id }));
  }

  // ── Writing turns back ───────────────────────────────────────────────────
  // Same row shape and same conflict target as the extension, which is what
  // makes a turn written here visible there. `seq` is deliberately absent: the
  // new client does not write it and the column's NOT NULL was dropped for
  // exactly this.
  const BATCH = 100;

  async function push(videoId, rows) {
    const account = accountId();
    if (!account || !rows.length) return { ok: false };
    const deviceId = await deviceIdOnce();
    const payload = rows.map((t) => ({
      account_id: account,
      video_id: videoId,
      turn_uid: t.uid,
      authored_at: t.authoredAt || new Date().toISOString(),
      device_id: deviceId,
      role: t.role,
      content: t.text,
    }));
    for (let i = 0; i < payload.length; i += BATCH) {
      await post('/rest/v1/video_chat_turns?on_conflict=account_id,video_id,turn_uid',
        payload.slice(i, i + BATCH), 'resolution=merge-duplicates,return=minimal');
    }
    return { ok: true, pushed: payload.length };
  }

  // A stable id for this browser, minted once. The extension keeps the same
  // notion under 'user_id'; the column exists so a turn can be traced to where
  // it was typed.
  let deviceIdCache = null;
  async function deviceIdOnce() {
    if (deviceIdCache) return deviceIdCache;
    const stored = await WcStore.one('wcDeviceId', null);
    if (stored) { deviceIdCache = stored; return stored; }
    const fresh = (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'wc-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    await WcStore.set({ wcDeviceId: fresh });
    deviceIdCache = fresh;
    return fresh;
  }

  function newUid() {
    return (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u' + Date.now() + Math.floor(Math.random() * 1e6);
  }

  global.WcHistory = {
    STANDALONE_PREFIX,
    keyForSession,
    sessionIdOfKey,
    attachmentOf,
    createSession,
    listChats,
    renameChat,
    setChatHidden,
    requestTitle,
    turns,
    actionBranchTurns,
    push,
    newUid,
    TAG,
  };
})(typeof self !== 'undefined' ? self : globalThis);
