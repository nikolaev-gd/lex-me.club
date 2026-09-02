// webchat/wc-wipe.js — что остаётся на устройстве, когда за него садится другой.
//
// ОДНА функция на два случая, и это принципиально: выход и вход ДРУГИМ
// аккаунтом без предшествующего выхода обязаны давать одно и то же состояние —
// состояние первого запуска. Разойдись они, и «закрыл вкладку не выходя» стало
// бы способом протащить свои данные следующему человеку. Зеркало
// wipeAccountScopedData в background.js расширения; расхождение между ними —
// баг, а не разница поверхностей.
//
// ИНВЕРСИЯ: остаток считается АККАУНТНЫМ и стирается. Переживает чистку только
// то, что перечислено здесь поимённо. Промах в эту сторону стоит сброшенной
// настройки; промах в обратную — чужих бесед на экране, и он уже случался:
// второй аккаунт видел первые фразы бесед первого (кэш превью, теперь снят:
// список бесед приходит с сервера и на устройстве не оседает вовсе).
//
// Три хранилища, и у каждого своя причина для своего способа:
//   • lex_webchat (kv)          — перечислить и снести всё, кроме device-ключей;
//   • lex_webchat_images        — картинки сообщений, на сервере их нет вовсе;
//   • localStorage              — ПОИМЁННО. У lex-me.club общий origin с
//     /account и /checkout, и clear() снёс бы заодно их состояние. Пропуск
//     (lexSession) снимает сам выход, а wcDebug принадлежит устройству.
(function (global) {
  'use strict';

  // Ключи kv, которые переживают смену человека. Всё остальное — его.
  const DEVICE_SCOPED = new Set([
    // Идентификатор УСТАНОВКИ. Им подписаны реплики (video_chat_turns.device_id),
    // чтобы отличать «это писали здесь» от «это приехало с телефона»; к тому,
    // кто вошёл, он отношения не имеет и при смене человека не меняется.
    'wcDeviceId',
    // Отметка «под кем в прошлый раз входили на этом устройстве» — сама основа
    // детекта смены. Снеси её вместе с остальным, и следующий вход не с чем
    // будет сравнить: чистка не сработала бы ровно там, где нужна.
    'wcLastAccountId',
  ]);

  const IMAGES_DB = 'lex_webchat_images';
  const IMAGES_STORE = 'images';

  // Своё соединение, а не то, что кэширует wc-attach.js: смены версии здесь нет,
  // параллельные соединения к одной базе законны, а чистка не должна зависеть от
  // того, открывал ли кто-нибудь до неё вложения.
  function clearImages() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(IMAGES_DB); } catch (_) { resolve(0); return; }
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(IMAGES_STORE)) { db.close(); resolve(0); return; }
          const t = db.transaction(IMAGES_STORE, 'readwrite');
          t.objectStore(IMAGES_STORE).clear();
          t.oncomplete = () => { db.close(); resolve(1); };
          t.onerror = () => { db.close(); resolve(0); };
        } catch (_) { try { db.close(); } catch (__) {} resolve(0); }
      };
    });
  }

  async function run(reason) {
    let kv = 0;
    try {
      const all = await WcStore.keys();
      const doomed = all.filter((k) => !DEVICE_SCOPED.has(k));
      if (doomed.length) await WcStore.remove(doomed);
      kv = doomed.length;
    } catch (err) { console.warn('[wc] wipe kv:', err && err.message); }
    const images = await clearImages();
    if (typeof lexLog === 'function') lexLog('[wc] wipe (' + reason + '): kv=' + kv + ' images=' + images);
    return { kv, images };
  }

  // Смена человека на этом устройстве. Зовётся из enterApp — единственной точки,
  // через которую страница попадает в приложение, каким бы путём ни пришёл вход
  // (форма, регистрация, возврат от Google, уже лежавший пропуск). Поэтому
  // «вошёл другим, не выходя» ловится здесь так же, как обычный вход.
  const LAST_ACCOUNT_KEY = 'wcLastAccountId';
  async function resetIfAccountChanged(accountId) {
    if (!accountId) return false;
    let wiped = false;
    try {
      const last = await WcStore.one(LAST_ACCOUNT_KEY, null);
      if (last && last !== accountId) { await run('account switch'); wiped = true; }
      await WcStore.set({ [LAST_ACCOUNT_KEY]: accountId });
    } catch (err) { console.warn('[wc] account check:', err && err.message); }
    return wiped;
  }

  global.WcWipe = { run, resetIfAccountChanged };
})(typeof self !== 'undefined' ? self : globalThis);
