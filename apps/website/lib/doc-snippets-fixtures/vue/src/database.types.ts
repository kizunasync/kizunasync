/** The `supabase gen types` shape of the tables the docs use, for pages that import `Database` without writing `src/database.types.ts`. */
export type Database = {
  public: {
    Tables: {
      todos: {
        Row: { id: string; title: string; done: boolean; user_id: string; created_at: string; image_path: string | null; likes: number; version: number; tags: string[]; workspace_id: string | null }
        Insert: { id?: string; title: string; done?: boolean; user_id?: string; created_at?: string; image_path?: string | null; likes?: number; version?: number; tags?: string[]; workspace_id?: string | null }
        Update: { id?: string; title?: string; done?: boolean; user_id?: string; created_at?: string; image_path?: string | null; likes?: number; version?: number; tags?: string[]; workspace_id?: string | null }
        Relationships: []
      }
      todo_templates: {
        Row: { id: string }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      boards: {
        Row: { id: string; created_by_user_id: string; cover: string | null }
        Insert: { id?: string; created_by_user_id?: string; cover?: string | null }
        Update: { id?: string; created_by_user_id?: string; cover?: string | null }
        Relationships: []
      }
      workspace_items: {
        Row: { id: string; workspace_id: string }
        Insert: { id?: string; workspace_id: string }
        Update: { id?: string; workspace_id?: string }
        Relationships: []
      }
      catalogs: {
        Row: { id: string }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      notes: {
        Row: { id: string; deleted_at: string | null }
        Insert: { id?: string; deleted_at?: string | null }
        Update: { id?: string; deleted_at?: string | null }
        Relationships: []
      }
      note_updates: {
        Row: { id: string; note_id: string; update_id: string; bytes: string }
        Insert: { id?: string; note_id: string; update_id: string; bytes: string }
        Update: { id?: string; note_id?: string; update_id?: string; bytes?: string }
        Relationships: []
      }
      projects: {
        Row: { id: string; owner_id: string; name: string; budget: number; archived_at: string | null }
        Insert: { id?: string; owner_id?: string; name: string; budget?: number; archived_at?: string | null }
        Update: { id?: string; owner_id?: string; name?: string; budget?: number; archived_at?: string | null }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
