/**
 * Configuration and constants for HealOps GitHub App Agent.
 */

import "dotenv/config";

/**
 * Async utility to enforce pacing between API calls.
 * @param {number} [ms=2000]
 * @returns {Promise<void>}
 */
export const sleep = (ms = 2000) => new Promise((resolve) => setTimeout(resolve, ms));

export const CONFIG = {
  MAX_RETRY_ITERATIONS: parseInt(process.env.MAX_RETRY_ITERATIONS || "3", 10),
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  GROQ_TURN_DELAY_MS: parseInt(process.env.GROQ_TURN_DELAY_MS || "2000", 10),
  PORT: parseInt(process.env.PORT || "3000", 10),
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
};

export default CONFIG;
