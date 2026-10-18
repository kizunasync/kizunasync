/** The Supabase client a docs code block imports when its page never writes `src/supabase-client.ts`. */
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const supabase = createClient<Database>('https://example.supabase.co', 'example-publishable-key')
