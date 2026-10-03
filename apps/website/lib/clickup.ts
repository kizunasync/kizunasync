/**
 * Each submission does TWO things: it creates a ClickUp task (the durable record,
 * in the feedback list) AND posts a Markdown message into a ClickUp Chat channel
 * for visibility. Markdown renders natively in both: the task via
 * `markdown_content` (the plain-text `description` field does NOT render
 * markdown), the chat message via `content_format: text/md`. Server-only: the
 * token comes from a non-public env var.
 */
// MARK: - ClickUp delivery

const API_V2 = 'https://api.clickup.com/api/v2'
const API_V3 = 'https://api.clickup.com/api/v3'
const TIMEOUT_MS = 10_000

export type TFeedbackReason = 'feedback' | 'bug' | 'question'

interface IFeedbackSubmission {
  reason: TFeedbackReason
  email: string
  name?: string
  area?: string
  version?: string
  message: string
}

const REASON_LABEL: Record<TFeedbackReason, string> = {
  feedback: 'Feedback',
  bug: 'Bug report',
  question: 'Question',
}

/** Token + target list must be set for submissions to be recorded as tasks. */
export function isClickUpConfigured(): boolean {
  return (
    (process.env.WEBSITE_CLICKUP_API_TOKEN ?? '') !== '' &&
    (process.env.WEBSITE_CLICKUP_CONTACT_LIST_ID ?? '') !== ''
  )
}

/** Markdown body shared by the task description and the chat message. */
function buildMarkdown(input: IFeedbackSubmission): string {
  return [
    `**Type:** ${REASON_LABEL[input.reason]}`,
    `**Email:** ${input.email}`,
    ...(input.name !== undefined && input.name !== '' ? [`**Name:** ${input.name}`] : []),
    ...(input.area !== undefined && input.area !== '' ? [`**Area:** ${input.area}`] : []),
    ...(input.version !== undefined && input.version !== '' ? [`**Version:** ${input.version}`] : []),
    '',
    '**Message:**',
    input.message,
    '',
    '_Sent from the kizunasync.com feedback form._',
  ].join('\n')
}

/** AbortSignal that fires after TIMEOUT_MS, plus a clear() to cancel the timer. */
function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/**
 * Creates the ClickUp task for a submission (the durable record). Best-effort
 * with a 10s timeout; returns false on any failure so the route can surface a
 * clean error instead of throwing. Uses `markdown_content` so the body renders.
 */
export async function createFeedbackTask(input: IFeedbackSubmission): Promise<boolean> {
  const token = process.env.WEBSITE_CLICKUP_API_TOKEN ?? ''
  const listId = process.env.WEBSITE_CLICKUP_CONTACT_LIST_ID ?? ''

  if (token === '' || listId === '') {
    return false
  }

  const name = `[${input.reason}] ${input.email}${
    input.area !== undefined && input.area !== '' ? ` · ${input.area}` : ''
  }`
  const { signal, clear } = withTimeout()

  try {
    const response = await fetch(`${API_V2}/list/${listId}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: JSON.stringify({ name, markdown_content: buildMarkdown(input) }),
      signal,
    })

    return response.ok
  } catch {
    return false
  } finally {
    clear()
  }
}

/**
 * Posts the submission as a Markdown message to the configured ClickUp Chat
 * channel. Additive and best-effort: returns false (without throwing) when the
 * channel isn't configured or the call fails, so it never blocks the recorded task.
 */
export async function postFeedbackMessage(input: IFeedbackSubmission): Promise<boolean> {
  const token = process.env.WEBSITE_CLICKUP_API_TOKEN ?? ''
  const workspaceId = process.env.WEBSITE_CLICKUP_WORKSPACE_ID ?? ''
  const channelId = process.env.WEBSITE_CLICKUP_CONTACT_CHANNEL_ID ?? ''

  if (token === '' || workspaceId === '' || channelId === '') {
    return false
  }

  const { signal, clear } = withTimeout()

  try {
    const response = await fetch(
      `${API_V3}/workspaces/${workspaceId}/chat/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: token },
        body: JSON.stringify({
          type: 'message',
          content: buildMarkdown(input),
          content_format: 'text/md',
        }),
        signal,
      },
    )

    return response.ok
  } catch {
    return false
  } finally {
    clear()
  }
}
