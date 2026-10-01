// Kopiere diese Datei zu config.js und trag deine Werte ein.
// config.js wird NICHT nach GitHub hochgeladen (siehe .gitignore) - aber das
// ist reine Ordnungsliebe: beide Werte hier sind oeffentlich und duerfen es
// sein. Die Rechte liegen in den RLS-Regeln der Datenbank, nicht im Schluessel.
//
// Beide Werte findest du in Supabase unter Settings -> API.
// Nimm den "anon public" Schluessel, NIEMALS den "service_role" Schluessel.

window.CONFIG = {
  SUPABASE_URL: "https://DEIN-PROJEKT.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
