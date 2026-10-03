import { createClient } from '@supabase/supabase-js'

// MARK: - supabase-js client

/**
 * Reads the product-prefixed Vite env so it ships to the browser bundle.
 * Normal todo CRUD goes through the kizunasync wrapper; auth and the conflict
 * lab's deliberate out-of-band update use this Supabase client directly.
 */
const supabaseUrl = import.meta.env.VITE_TODO_REACT_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_TODO_REACT_SUPABASE_PUBLISHABLE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)
