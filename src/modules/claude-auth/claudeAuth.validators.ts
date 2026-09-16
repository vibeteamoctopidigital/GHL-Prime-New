import { z } from 'zod'

/**
 * The OAuth code the admin pastes back after approving in the browser. The
 * CLI itself validates the real value — this only guards length and charset
 * so garbage never reaches the PTY stdin.
 */
export const submitCodeSchema = z.object({
  code: z.string().min(1).max(2_000),
})

export type SubmitCodeInput = z.infer<typeof submitCodeSchema>
