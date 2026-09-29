/**
 * Minimal ambient type for `expo/fetch` (Expo's WHATWG-compliant native fetch).
 * The full `expo` package is not a build dependency here: the consuming app
 * provides the runtime (declared as a peer). We only touch the response's ok /
 * status / arrayBuffer(), so we declare exactly that and nothing else.
 */
declare module 'expo/fetch' {
  export function fetch(
    input: string,
    init?: unknown,
  ): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
}
