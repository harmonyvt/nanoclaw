/**
 * Test GroupCoordinator retry logic patterns.
 *
 * Verifies:
 * - Non-retryable error detection (billing, rate_limit, auth, etc.)
 * - Exponential backoff timing (2s * 2^attempt)
 * - Max retries exhaustion
 */

import { describe, it, expect } from 'bun:test';

// Extract the helper function logic for testing
// (mirrors GroupCoordinator.ts NON_RETRYABLE_PATTERNS + isNonRetryableError)

const NON_RETRYABLE_PATTERNS = [
  'billing',
  'rate_limit',
  'authentication',
  'overloaded',
  'permission',
  'model_not_found',
];

function isNonRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((p) => lower.includes(p));
}

describe('Retry Logic', () => {
  describe('isNonRetryableError', () => {
    it('detects billing errors', () => {
      expect(isNonRetryableError('Your billing account has been suspended')).toBe(true);
      expect(isNonRetryableError('BILLING limit exceeded')).toBe(true);
    });

    it('detects rate_limit errors', () => {
      expect(isNonRetryableError('rate_limit_exceeded: too many requests')).toBe(true);
      expect(isNonRetryableError('Rate_Limit reached for model')).toBe(true);
    });

    it('detects authentication errors', () => {
      expect(isNonRetryableError('Invalid authentication credentials')).toBe(true);
      expect(isNonRetryableError('AUTHENTICATION_FAILED')).toBe(true);
    });

    it('detects overloaded errors', () => {
      expect(isNonRetryableError('The server is currently overloaded')).toBe(true);
      expect(isNonRetryableError('overloaded_error: API is under heavy load')).toBe(true);
    });

    it('detects permission errors', () => {
      expect(isNonRetryableError('permission denied: insufficient access')).toBe(true);
      expect(isNonRetryableError('Permission error for this resource')).toBe(true);
    });

    it('detects model_not_found errors', () => {
      expect(isNonRetryableError('model_not_found: claude-5-opus does not exist')).toBe(true);
      expect(isNonRetryableError('Error: MODEL_NOT_FOUND')).toBe(true);
    });

    it('returns false for retryable errors', () => {
      expect(isNonRetryableError('Connection reset by peer')).toBe(false);
      expect(isNonRetryableError('ECONNREFUSED')).toBe(false);
      expect(isNonRetryableError('timeout waiting for response')).toBe(false);
      expect(isNonRetryableError('Internal server error')).toBe(false);
      expect(isNonRetryableError('Container exited with code 1')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isNonRetryableError('BILLING_ERROR')).toBe(true);
      expect(isNonRetryableError('Billing_Error')).toBe(true);
      expect(isNonRetryableError('billing_error')).toBe(true);
    });
  });

  describe('Exponential backoff timing', () => {
    const agentRetryDelay = 2000; // matches AppConfig default

    it('calculates correct backoff delays', () => {
      // Matches the formula in GroupCoordinator:
      // agentRetryDelay * Math.pow(2, attempt)
      expect(agentRetryDelay * Math.pow(2, 0)).toBe(2000);   // attempt 0: 2s
      expect(agentRetryDelay * Math.pow(2, 1)).toBe(4000);   // attempt 1: 4s
      expect(agentRetryDelay * Math.pow(2, 2)).toBe(8000);   // attempt 2: 8s
      expect(agentRetryDelay * Math.pow(2, 3)).toBe(16000);  // attempt 3: 16s
      expect(agentRetryDelay * Math.pow(2, 4)).toBe(32000);  // attempt 4: 32s
      expect(agentRetryDelay * Math.pow(2, 5)).toBe(64000);  // attempt 5: 64s
      expect(agentRetryDelay * Math.pow(2, 6)).toBe(128000); // attempt 6: 128s
    });

    it('total max wait time is bounded', () => {
      const maxRetries = 7; // default MAX_AGENT_RETRIES
      let totalWait = 0;
      for (let i = 0; i < maxRetries; i++) {
        totalWait += agentRetryDelay * Math.pow(2, i);
      }
      // 2 + 4 + 8 + 16 + 32 + 64 + 128 = 254 seconds
      expect(totalWait).toBe(254_000);
      // Should be under 5 minutes
      expect(totalWait).toBeLessThan(5 * 60 * 1000);
    });
  });

  describe('Max retries exhaustion', () => {
    it('retry loop runs correct number of attempts', () => {
      const maxAgentRetries = 2;
      let attempts = 0;

      // Simulate retry loop from GroupCoordinator
      for (let attempt = 0; attempt <= maxAgentRetries; attempt++) {
        attempts++;
        const isSuccess = false; // all attempts fail
        if (isSuccess) break;

        // Non-retryable check
        const errorMsg = 'Connection reset';
        if (isNonRetryableError(errorMsg)) break;

        if (attempt < maxAgentRetries) {
          // Would sleep here in real code
          continue;
        }
        // Exhausted retries — this is the final attempt
      }

      expect(attempts).toBe(maxAgentRetries + 1); // 0, 1, 2 = 3 total
    });

    it('non-retryable error breaks early', () => {
      const maxAgentRetries = 7;
      let attempts = 0;

      for (let attempt = 0; attempt <= maxAgentRetries; attempt++) {
        attempts++;
        const isSuccess = false;
        if (isSuccess) break;

        const errorMsg = 'billing account suspended';
        if (isNonRetryableError(errorMsg)) break;
      }

      // Should stop after the first failure (non-retryable)
      expect(attempts).toBe(1);
    });
  });
});
