export function norm(str: string) {
  return (str || '').trim().toLowerCase();
}
export function sanitizeUsername(u: string) {
  return norm(u)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
