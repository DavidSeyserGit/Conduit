type UpdateInfo = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  body?: string;
  date?: string;
};

const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!inTauri()) {
    try {
      const res = await fetch("https://api.github.com/repos/DavidSeyserGit/Conduit/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return null;
      const data = await res.json() as { tag_name: string; body?: string; published_at?: string };
      const current = "0.1.0";
      const latest = (data.tag_name || "").replace(/^v/, "");
      return {
        available: latest !== "" && latest !== current,
        currentVersion: current,
        latestVersion: latest || current,
        body: data.body,
        date: data.published_at,
      };
    } catch { return null; }
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { available: false, currentVersion: "0.1.0", latestVersion: "0.1.0" };
    return {
      available: true,
      currentVersion: update.currentVersion,
      latestVersion: update.version,
      body: update.body,
    };
  } catch {
    return null;
  }
}

export async function downloadAndInstallUpdate(onEvent?: (ev: { event: string; data?: unknown }) => void): Promise<void> {
  if (!inTauri()) {
    window.open("https://github.com/DavidSeyserGit/Conduit/releases/latest", "_blank");
    return;
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const update = await check();
  if (!update) return;
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((ev) => {
    switch (ev.event) {
      case "Started":
        total = ev.data.contentLength ?? 0;
        onEvent?.({ event: "started", data: ev.data });
        break;
      case "Progress":
        downloaded += ev.data.chunkLength ?? 0;
        onEvent?.({ event: "progress", data: { downloaded, total } });
        break;
      case "Finished":
        onEvent?.({ event: "finished" });
        break;
    }
  });
  await relaunch();
}
