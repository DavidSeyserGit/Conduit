export function normalizeNeonAuthUrl(input: string | undefined): string | null {
  const value = input?.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const isLocalDevelopment = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !isLocalDevelopment) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}
