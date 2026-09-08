import OpenAI from 'openai'

/**
 * Direct OpenAI API calls — used only for the 'openai-api' transport (an
 * admin-pasted OpenAI API key, the advanced/metered fallback when no ambient
 * Codex login is connected). Claude generation always goes through the CLI
 * now (blogAi.cliRunner.ts) to bill against the subscription instead of
 * per-token API usage — see docs/BLOG_AI.md.
 */

const GENERATION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes — a full blog post generation
const TEST_TIMEOUT_MS = 30 * 1000 // 30 seconds — the "Test connection" buttons
const RESEARCH_TIMEOUT_MS = 60 * 1000 // one minute — a handful of searches, not a full article

const DEFAULT_OPENAI_MODEL = 'gpt-4o'

export interface TestResult {
  ok: boolean
  message: string
}

export async function invokeOpenAI(opts: {
  apiKey: string
  model?: string | undefined
  prompt: string
  jsonSchema: Record<string, unknown>
}): Promise<string> {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: GENERATION_TIMEOUT_MS })

  const response = await client.chat.completions.create({
    model: opts.model || DEFAULT_OPENAI_MODEL,
    messages: [{ role: 'user', content: opts.prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'blog_post', schema: opts.jsonSchema, strict: true },
    },
  })

  const text = response.choices[0]?.message?.content
  if (!text) throw new Error('OpenAI returned an empty response')
  return text
}

export async function testOpenAiAccount(opts: { apiKey: string; model?: string | undefined }): Promise<TestResult> {
  try {
    const client = new OpenAI({ apiKey: opts.apiKey, timeout: TEST_TIMEOUT_MS })
    const response = await client.chat.completions.create({
      model: opts.model || DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 16,
    })

    const text = response.choices[0]?.message?.content ?? ''
    return { ok: true, message: text.trim().slice(0, 200) || '(empty reply)' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Returns the raw text OpenAI produced after doing its own web research (Responses API). */
export async function researchWithOpenAi(opts: { apiKey: string; model?: string | undefined; prompt: string }): Promise<string> {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: RESEARCH_TIMEOUT_MS })

  const response = await client.responses.create({
    model: opts.model || DEFAULT_OPENAI_MODEL,
    tools: [{ type: 'web_search' }],
    input: opts.prompt,
  })

  return response.output_text ?? ''
}
