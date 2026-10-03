/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_SUPABASE_URL: string
  readonly VITE_DEMO_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_DEMO_TURNSTILE_SITE_KEY?: string
  readonly VITE_DEMO_GTM_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
