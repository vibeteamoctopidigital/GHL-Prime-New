/**
 * Minimal ambient declaration for node-pty, which ships no type definitions.
 * Only the surface claudeAuth.service.ts actually uses is declared.
 */
declare module 'node-pty' {
  export interface IPty {
    readonly pid: number
    write(data: string): void
    kill(signal?: string): void
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  }

  export interface IPtySpawnOptions {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
  }

  export function spawn(file: string, args: string[], options: IPtySpawnOptions): IPty
}
