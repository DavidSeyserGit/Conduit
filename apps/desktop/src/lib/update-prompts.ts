export interface ReleaseChangelog {
  version: string;
  body: string;
  publishedAt?: string;
}

export interface UpdateAvailability {
  available: boolean;
  latestVersion: string;
}

/** The update popup appears unless the user skipped exactly this version. */
export function shouldShowUpdatePopup(
  info: UpdateAvailability | null | undefined,
  skippedVersion?: string,
): boolean {
  return Boolean(info?.available && info.latestVersion && info.latestVersion !== skippedVersion);
}

/** Show the changelog when the version differs from the last one seen. A
 * missing lastSeen counts as "show": users updating from pre-changelog
 * versions (and fresh installs, as a welcome card) get the notes too. */
export function shouldShowChangelog(currentVersion: string | null, lastSeen: string | undefined): boolean {
  return Boolean(currentVersion && currentVersion !== lastSeen);
}

/** Release notes for a tag, generated from git history by the release workflow. */
export async function fetchReleaseChangelog(
  version: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReleaseChangelog | null> {
  try {
    const response = await fetchFn(
      `https://api.github.com/repos/DavidSeyserGit/Conduit/releases/tags/v${version}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return null;
    const data = await response.json() as { tag_name?: string; body?: string; published_at?: string };
    if (!data.body) return null;
    return { version: (data.tag_name ?? `v${version}`).replace(/^v/, ""), body: data.body, publishedAt: data.published_at };
  } catch {
    return null;
  }
}
