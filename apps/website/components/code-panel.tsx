import { CODE_THEME, getHighlighter } from '@/lib/code-highlight'
import { FrameworkTabs } from '@/components/framework-tabs'

// MARK: - CodePanel

/**
 * Framework-specific examples for the shipped local query API. Highlighted by
 * the shared Shiki instance and rendered through the same tab primitive as the
 * quickstart, keeping every variant in the server-rendered HTML.
 */
const SNIPPETS = [
  {
    label: 'React',
    lang: 'tsx',
    code: `import { useMutation, useQuery } from '@kizunasync/react'

export function Todos() {
  const { data: todos, isLoading } = useQuery((kizunasync) =>
    kizunasync.from('todos').select().eq('done', false).order('created_at'),
  )
  const { mutate } = useMutation()

  const addTodo = (title: string) =>
    mutate((kizunasync) =>
      kizunasync.from('todos').insert({
        id: crypto.randomUUID(), title, done: false,
      }),
    )

  const toggleTodo = (id: string, done: boolean) =>
    mutate((kizunasync) => kizunasync.from('todos').update({ done }).eq('id', id))

  if (isLoading) {
    return <p>Loading…</p>
  }

  return <TodoList todos={todos} onAdd={addTodo} onToggle={toggleTodo} />
}`,
  },
  {
    label: 'Vue',
    lang: 'vue',
    code: `<script setup lang="ts">
import { useMutation, useQuery } from '@kizunasync/vue'

const { data: todos, isLoading } = useQuery((kizunasync) =>
  kizunasync.from('todos').select().eq('done', false).order('created_at'),
)
const { mutate } = useMutation()

const addTodo = (title: string) =>
  void mutate((kizunasync) =>
    kizunasync.from('todos').insert({
      id: crypto.randomUUID(), title, done: false,
    }),
  )

const toggleTodo = (id: string, done: boolean) =>
  void mutate((kizunasync) => kizunasync.from('todos').update({ done }).eq('id', id))
</script>

<template>
  <p v-if="isLoading">Loading…</p>
  <TodoList v-else :todos="todos" @add="addTodo" @toggle="toggleTodo" />
</template>`,
  },
  {
    label: 'Expo/React Native',
    lang: 'tsx',
    code: `import { useCallback } from 'react'
import { FlatList, Pressable, Text } from 'react-native'
import { randomUUID } from 'expo-crypto'
import { useMutation, useQuery } from '@kizunasync/react'
import type { IKizunaSync } from '@kizunasync/core'

export default function TodosScreen() {
  const buildTodos = useCallback(
    (kizunasync: IKizunaSync) =>
      kizunasync.from('todos').select().eq('done', false).order('created_at'),
    [],
  )
  const { data: todos } = useQuery(buildTodos)
  const { mutate } = useMutation()

  const addTodo = () =>
    mutate((kizunasync) =>
      kizunasync.from('todos').insert({
        id: randomUUID(), title: 'Offline todo', done: false,
      }),
    )

  return <FlatList data={todos} renderItem={({ item }) => <Text>{item.title}</Text>}
    ListFooterComponent={<Pressable onPress={addTodo}><Text>Add todo</Text></Pressable>} />
}`,
  },
  {
    label: 'Swift',
    lang: 'swift',
    code: `import Foundation
import KizunaSync

let rows = try await client.query(table: "todos")
try await client.apply(
  table: "todos",
  pk: UUID().uuidString,
  op: .insert,
  columns: ["title": "Offline todo", "done": false]
)
try await client.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: ["done": true]
)`,
  },
  {
    label: 'Kotlin',
    lang: 'kotlin',
    code: `import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncOp
import java.util.UUID

suspend fun writeTodos(client: KizunaSyncClient, todoId: String) {
    val rows = client.query(table = "todos")
    client.apply(
        table = "todos",
        pk = UUID.randomUUID().toString(),
        op = KizunaSyncOp.Insert,
        columns = mapOf("title" to "Offline todo", "done" to false),
    )
    client.apply(
        table = "todos",
        pk = todoId,
        op = KizunaSyncOp.Update,
        columns = mapOf("done" to true),
    )
}`,
  },
  {
    label: 'Vanilla / other',
    lang: 'ts',
    code: `const { data: todos } = await kizunasync.from('todos').select().eq('done', false).order('created_at')

await kizunasync.from('todos').insert({
  id: crypto.randomUUID(), title: 'Offline todo', done: false,
})

await kizunasync.from('todos').update({ done: true }).eq('id', todoId)`,
  },
] as const

export async function CodePanel() {
  const highlighter = await getHighlighter()
  const groups = SNIPPETS.map((snippet) => ({
    label: snippet.label,
    code: snippet.code,
    html: highlighter.codeToHtml(snippet.code, { lang: snippet.lang, theme: CODE_THEME }),
  }))

  return <FrameworkTabs groups={groups} />
}
