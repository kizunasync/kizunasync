/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import type { IKizunaSync } from 'kizunasync'
import { forceServerConflict, type IConflictDrillRemote } from './conflict-drills'

const fakeClient = (row: { id: string; title: string } | undefined): Pick<IKizunaSync, 'from'> => ({
  from: () => ({ select: async () => ({ data: row === undefined ? [] : [row], error: null }) }) as never,
})

describe('forceServerConflict', () => {
  test('reports there is nothing to conflict when the table is empty', async () => {
    const supabase: IConflictDrillRemote = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }

    expect(await forceServerConflict(supabase, fakeClient(undefined), 'todos')).toBe('add a todo first')
  })

  test('edits the top row on the server and reports the race', async () => {
    let updatedTable = ''
    let updatedValues: Record<string, unknown> = {}
    let updatedId = ''
    const supabase: IConflictDrillRemote = {
      from: (table) => {
        updatedTable = table

        return {
          update: (values) => {
            updatedValues = values

            return {
              eq: async (column, value) => {
                expect(column).toBe('id')
                updatedId = value

                return { error: null }
              },
            }
          },
        }
      },
    }

    const result = await forceServerConflict(supabase, fakeClient({ id: 'row-1', title: 'Buy milk' }), 'todos')

    expect(updatedTable).toBe('todos')
    expect(updatedId).toBe('row-1')
    expect(updatedValues).toEqual({ title: 'Buy milk (edited on server)' })
    expect(result).toBe('the server now disagrees with the device: edit locally, then sync, and watch who wins')
  })

  test('reports a failed server edit', async () => {
    const supabase: IConflictDrillRemote = {
      from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'network down' } }) }) }),
    }
    const result = await forceServerConflict(supabase, fakeClient({ id: 'row-1', title: 'Buy milk' }), 'todos')

    expect(result).toBe('server edit failed: network down')
  })
})
