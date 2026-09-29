// MARK: - createFilterMethods

import { describe, expect, test } from 'bun:test'
import { EEngineErrorCode, TEngineError, type TQueryFilter } from '../wire/types'
import { createFilterMethods, unsupported } from './filter-methods'

const setup = (): { filters: TQueryFilter[]; self: ReturnType<typeof createFilterMethods<'SELF'>> } => {
  const filters: TQueryFilter[] = []
  const self = createFilterMethods<'SELF'>(filters, () => 'SELF')

  return { filters, self }
}

describe('createFilterMethods', () => {
  test('eq pushes an eq filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.eq('title', 'a')).toBe('SELF')
    expect(filters).toEqual([{ kind: 'eq', column: 'title', value: 'a' }])
  })

  test('neq pushes a neq filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.neq('done', false)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'neq', column: 'done', value: false }])
  })

  test('gt pushes a gt filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.gt('rank', 1)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'gt', column: 'rank', value: 1 }])
  })

  test('gte pushes a gte filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.gte('rank', 1)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'gte', column: 'rank', value: 1 }])
  })

  test('lt pushes a lt filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.lt('rank', 9)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'lt', column: 'rank', value: 9 }])
  })

  test('lte pushes a lte filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.lte('rank', 9)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'lte', column: 'rank', value: 9 }])
  })

  test('like pushes a like filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.like('title', '%a%')).toBe('SELF')
    expect(filters).toEqual([{ kind: 'like', column: 'title', pattern: '%a%' }])
  })

  test('ilike pushes an ilike filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.ilike('title', '%A%')).toBe('SELF')
    expect(filters).toEqual([{ kind: 'ilike', column: 'title', pattern: '%A%' }])
  })

  test('is pushes an is filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.is('archived_at', null)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'is', column: 'archived_at', value: null }])
  })

  test('in pushes an in filter with a defensive copy of the values and returns self', () => {
    const { filters, self } = setup()
    const values = [1, 2, 3]

    expect(self.in('rank', values)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'in', column: 'rank', values: [1, 2, 3] }])

    values.push(4)
    expect(filters).toEqual([{ kind: 'in', column: 'rank', values: [1, 2, 3] }])
  })

  test('contains pushes a contains filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.contains('tags', ['a', 'b'])).toBe('SELF')
    expect(filters).toEqual([{ kind: 'contains', column: 'tags', value: ['a', 'b'] }])
  })

  test('containedBy pushes a containedBy filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.containedBy('tags', ['a', 'b'])).toBe('SELF')
    expect(filters).toEqual([{ kind: 'containedBy', column: 'tags', value: ['a', 'b'] }])
  })

  test('or parses a PostgREST clause list into an or filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.or('rank.eq.1,rank.eq.3')).toBe('SELF')
    expect(filters).toEqual([
      {
        kind: 'or',
        filters: [
          { kind: 'eq', column: 'rank', value: 1 },
          { kind: 'eq', column: 'rank', value: 3 },
        ],
      },
    ])
  })

  test('and parses a PostgREST clause list into an and filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.and('done.eq.false,rank.gt.2')).toBe('SELF')
    expect(filters).toEqual([
      {
        kind: 'and',
        filters: [
          { kind: 'eq', column: 'done', value: false },
          { kind: 'gt', column: 'rank', value: 2 },
        ],
      },
    ])
  })

  test('not wraps a single filter and returns self', () => {
    const { filters, self } = setup()

    expect(self.not('rank', 'eq', 2)).toBe('SELF')
    expect(filters).toEqual([{ kind: 'not', filter: { kind: 'eq', column: 'rank', value: 2 } }])
  })

  // The next three tests pin the same LOCAL_UNSUPPORTED message the pre-split or/and/not methods produced.
  test('or maps a malformed clause to LOCAL_UNSUPPORTED with the same message as before', () => {
    const { self } = setup()
    const expected = unsupported(
      'or(\'not-a-clause\') (invalid filter clause "not-a-clause" (expected column.op.value))',
    )

    try {
      self.or('not-a-clause')

      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
      expect((error as TEngineError).message).toBe(expected.message)
    }
  })

  test('and maps an unknown operator to LOCAL_UNSUPPORTED with the same message as before', () => {
    const { self } = setup()
    const expected = unsupported(
      'and(\'rank.foo.1\') (unsupported filter operator "foo" in "rank.foo.1")',
    )

    try {
      self.and('rank.foo.1')

      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
      expect((error as TEngineError).message).toBe(expected.message)
    }
  })

  test('not maps an unsupported operator to LOCAL_UNSUPPORTED with the same message as before', () => {
    const { self } = setup()
    const expected = unsupported(
      'not(\'rank\', \'contains\', …) (unsupported not() operator "contains")',
    )

    try {
      self.not('rank', 'contains', 1)

      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
      expect((error as TEngineError).message).toBe(expected.message)
    }
  })
})
