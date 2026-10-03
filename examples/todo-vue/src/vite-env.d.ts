/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TODO_VUE_SUPABASE_URL: string
  readonly VITE_TODO_VUE_SUPABASE_PUBLISHABLE_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
