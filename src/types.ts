/**
 * Environment bindings for the CDP Worker
 */
export interface Env {
  // Browser Rendering binding
  BROWSER: Fetcher;
  // Shared secret for CDP endpoint authentication
  CDP_SECRET: string;
}

/**
 * CDP Message types
 */
export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}
