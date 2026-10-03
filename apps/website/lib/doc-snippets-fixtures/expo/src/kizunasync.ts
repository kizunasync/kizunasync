/** The app client a docs code block imports when its page never writes `src/kizunasync.ts`. */
import { byOwner, defineConfig } from 'kizunasync'
import { openExpoDriver } from 'kizunasync/expo'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({ supabase, driver: openExpoDriver('todos.db'), config })
