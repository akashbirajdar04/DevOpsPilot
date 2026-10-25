/**
 * Pre-commit secret scanning engine to prevent credential leaks in automated fix PRs.
 */

const SECRET_PATTERNS = {
  "AWS Access Key ID": /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/,
  "AWS Secret Key": /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/i,
  "GitHub Personal Access Token": /\bghp_[0-9a-zA-Z]{20,40}\b/,
  "GitHub Fine-Grained Token": /\bgithub_pat_[0-9a-zA-Z_]{70,90}\b/,
  "GitHub OAuth / App Token": /\b(gho|ghu|ghs|ghr)_[0-9a-zA-Z]{20,40}\b/,
  "Google API Key": /\bAIza[0-9A-Za-z\-_]{35}\b/,
  "Private Key Header": /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP)? PRIVATE KEY-----/,
  "Hardcoded Secret / Password": /\b(?:password|passwd|secret_key|api_secret|client_secret)\s*[:=]\s*['"][^'"]{8,}['"]/i,
};

/**
 * Scan file content or git diff for high-risk secrets.
 * @param {string} content - The code or diff content to scan
 * @param {string} [filename] - Optional filename for context
 * @returns {{ passed: boolean, violations: string[] }}
 */
export function scanContentForSecrets(content, filename = "file") {
  if (!content || typeof content !== "string") {
    return { passed: true, violations: [] };
  }

  // Reject .env files completely
  if (filename.endsWith(".env") || filename.includes(".env.")) {
    return {
      passed: false,
      violations: [`Prohibited file '${filename}': .env files must never be committed.`],
    };
  }

  const violations = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check added diff lines or normal lines
    const isAddition = line.startsWith("+") && !line.startsWith("+++");
    const textToCheck = isAddition ? line.slice(1) : line;

    for (const [name, pattern] of Object.entries(SECRET_PATTERNS)) {
      if (pattern.test(textToCheck)) {
        violations.push(`${filename}:${i + 1} - Potential ${name} detected.`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
