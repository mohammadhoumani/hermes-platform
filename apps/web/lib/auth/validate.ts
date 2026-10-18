/** Form checks that run in the browser before anything is sent. Messages are plain English. */

export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter your email address.";
  if (v.length > 254 || !EMAIL_RE.test(v)) return "Enter a valid email address, like name@example.com.";
  return null;
}

export function validatePassword(value: string): string | null {
  if (!value) return "Enter your password.";
  return null;
}

export function validateNewPassword(value: string): string | null {
  if (!value) return "Choose a password.";
  if (value.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (value.length > 72) return "Use 72 characters or fewer.";
  return null;
}

export function validateConfirm(password: string, confirm: string): string | null {
  if (!confirm) return "Type the password again.";
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

export function validateName(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter your name.";
  if (v.length > 80) return "Use 80 characters or fewer.";
  return null;
}
