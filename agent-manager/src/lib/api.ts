// API configuration - uses Vite proxy in development
export const apiUrl = (import.meta as any).env.VITE_API_URL || ''

const runtimeEnv = typeof window === 'undefined'
  ? undefined
  : (window as unknown as { __ENV__?: Record<string, string> }).__ENV__
export const nativeAgentUiEnabled =
  String(runtimeEnv?.VITE_NATIVE_AGENT_UI_ENABLED
    ?? import.meta.env.VITE_NATIVE_AGENT_UI_ENABLED
    ?? '').toLowerCase() === 'true'
