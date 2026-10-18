/** Expo Modules API 2.0 surface; engine and subscription ids stay strings across JSI. */
export interface IKizunaExpoModule {
  newEngineId(): string
  databasePath(name: string): string
  createEngine(id: string, configJson: string): Promise<void>
  call(id: string, method: string, paramsJson: string): string
  callAsync(id: string, method: string, paramsJson: string): Promise<string>
  closeEngine(id: string): Promise<void>
  addListener(name: 'engineEvent', listener: (payload: string) => void): { remove(): void }
}
