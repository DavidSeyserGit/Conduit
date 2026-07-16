// Asserts that releases/latest/download/latest.json matches the just-published
// tag. The release asset URL is CDN-cached, so this retries for a few minutes.
const [tag, repository] = process.argv.slice(2);
if (!tag || !repository) {
  throw new Error("Usage: node scripts/verify-release-manifest.mjs <tag> <owner/repo>");
}
const expectedVersion = tag.replace(/^v/, "");
const url = `https://github.com/${repository}/releases/latest/download/latest.json`;

const attempts = 18;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (response.ok) {
      const manifest = await response.json();
      const platforms = Object.entries(manifest.platforms ?? {});
      const problems = platforms
        .filter(([, entry]) => !entry?.signature || !entry?.url)
        .map(([name]) => name);
      if (manifest.version === expectedVersion && platforms.length > 0 && problems.length === 0) {
        process.stdout.write(
          `latest.json serves ${manifest.version} with ${platforms.length} signed platform entries\n`,
        );
        process.exit(0);
      }
      process.stdout.write(
        `attempt ${attempt}/${attempts}: manifest not ready (version=${manifest.version}, platforms=${platforms.length}, unsigned=${problems.length})\n`,
      );
    } else {
      process.stdout.write(`attempt ${attempt}/${attempts}: HTTP ${response.status}\n`);
    }
  } catch (error) {
    process.stdout.write(`attempt ${attempt}/${attempts}: ${error.message}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
throw new Error(`latest.json did not serve ${expectedVersion} with signed platforms in time`);
