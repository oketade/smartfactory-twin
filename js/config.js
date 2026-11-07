/* SmartFactory Twin 2.0 — deployment configuration.
   Leave SUPABASE_URL empty to run with the in-browser MOCK backend.

   Only the project URL and the public "anon" key belong here. The anon key is designed to be
   public: every write goes through the SECURITY DEFINER functions in supabase/schema.sql and
   row-level security blocks direct table writes. NEVER put the service_role key in this file
   or anywhere else in this repository. */
window.SF = window.SF || {};
window.SF.config = {
  SUPABASE_URL: 'https://pkpvrvpfknzeazfohbyz.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_KSnFT0OXxPK0Pfugpl9klA_MSnK57Ci',   // public "publishable" (anon) key — never the secret key
  // ?backend=mock in the URL forces the mock backend even when Supabase is configured
};
