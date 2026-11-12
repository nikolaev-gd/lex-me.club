/* config.js — the one place the address of the Lex server is written down.
 *
 * Since 2026-11-12 the address is Lex's own, api.lex-me.club: a gateway that
 * passes every request to the Lex server, wherever it lives. The page /app
 * carries the same address in app/lex-web-config.js.
 *
 * The key is the PUBLISHABLE key and belongs in client code: on its own it
 * grants nothing. Every read is authorised by the signed-in user's own JWT
 * against row-level security, so a session can only see its own rows.
 *
 * Keys get rotated (they were, on 2026-07-18, when the project moved off the
 * legacy anon key). Keeping them here means a rotation is a one-line edit, not
 * a search through the site.
 */
window.LEX_CONFIG = {
  supabaseUrl: 'https://api.lex-me.club',
  supabaseKey: 'sb_publishable_uFosC6xBOAeS0k9-G56bpQ_gylyq8st',
};
