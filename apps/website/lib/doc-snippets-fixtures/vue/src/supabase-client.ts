/** The Supabase client a docs code block imports when its page never writes `src/supabase-client.ts`. */
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (url === undefined || publishableKey === undefined) {
  throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.')
}

export const supabase = createClient<Database>(url, publishableKey)
