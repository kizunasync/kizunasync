/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { accountKeyForUserId, createDemoAccounts, DEMO_PASSWORD, REGISTERED_UID_NAMES, REGISTERED_UIDS } from './demo-accounts'

const MARY = '11111111-1111-4111-8111-111111111111'
const SAMUEL = '22222222-2222-4222-8222-222222222222'
const DAVID = '33333333-3333-4333-8333-333333333333'

describe('createDemoAccounts', () => {
  test('puts the caller-translated anonymous entry first, then the seeded users', () => {
    const accounts = createDemoAccounts('Anonymous')

    expect(accounts.map((account) => account.key)).toEqual(['anon', 'mary', 'samuel', 'david'])
    expect(accounts[0]).toEqual({ key: 'anon', label: 'Anonymous' })
  })

  test('the seeded users carry the migration 0002 credentials', () => {
    const accounts = createDemoAccounts('Anonymous')

    expect(accounts.slice(1)).toEqual([
      { key: 'mary', label: 'Mary', email: 'mary@kizunasync.local', uid: MARY },
      { key: 'samuel', label: 'Samuel', email: 'samuel@kizunasync.local', uid: SAMUEL },
      { key: 'david', label: 'David', email: 'david@kizunasync.local', uid: DAVID },
    ])
  })

  test('each call hands back its own rows', () => {
    const first = createDemoAccounts('Anonymous')
    const second = createDemoAccounts('Anonimo')

    expect(second[0]?.label).toBe('Anonimo')
    expect(first[0]?.label).toBe('Anonymous')
    expect(first[1]).not.toBe(second[1])
  })

  test('the demo password is the seeded one', () => {
    expect(DEMO_PASSWORD).toBe('kizunasync-demo')
  })
})

describe('row ownership', () => {
  test('only the seeded uids are registered', () => {
    expect([...REGISTERED_UIDS].sort()).toEqual([MARY, SAMUEL, DAVID])
    expect(REGISTERED_UIDS.has('99999999-9999-4999-8999-999999999999')).toBe(false)
  })

  test('the badge names come from the catalog', () => {
    expect(REGISTERED_UID_NAMES[MARY]).toBe('Mary')
    expect(REGISTERED_UID_NAMES[SAMUEL]).toBe('Samuel')
    expect(REGISTERED_UID_NAMES[DAVID]).toBe('David')
    expect(REGISTERED_UID_NAMES['unknown']).toBeUndefined()
  })
})

describe('accountKeyForUserId', () => {
  test('a persisted registered session selects its own pill', () => {
    expect(accountKeyForUserId(MARY)).toBe('mary')
    expect(accountKeyForUserId(DAVID)).toBe('david')
  })

  test('an anonymous or unknown id falls back to anon', () => {
    expect(accountKeyForUserId(null)).toBe('anon')
    expect(accountKeyForUserId('')).toBe('anon')
    expect(accountKeyForUserId('99999999-9999-4999-8999-999999999999')).toBe('anon')
  })
})
