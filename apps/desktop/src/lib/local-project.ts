export interface LocalProject {
  name: string;
  path: string;
}

export type DirectoryPicker = (options: {
  directory: true;
  multiple: false;
  title: string;
}) => Promise<string | string[] | null>;

export function localProjectFromPath(path: string): LocalProject {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("The selected folder did not provide a valid path.");

  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "") || trimmed;
  const name = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1);
  if (!name) throw new Error("Conduit could not determine a project name from the selected folder.");

  return { name, path: trimmed };
}

export async function pickLocalProject(openDirectory: DirectoryPicker): Promise<LocalProject | null> {
  const selected = await openDirectory({
    directory: true,
    multiple: false,
    title: "Open local project folder",
  });
  if (selected === null) return null;
  if (typeof selected !== "string") throw new Error("The folder picker returned an unexpected selection.");
  return localProjectFromPath(selected);
}

export function upsertProjectByPath<T extends { path: string }>(projects: T[], project: T): T[] {
  const existing = projects.find((candidate) => candidate.path === project.path);
  const nextProject = existing ? { ...existing, ...project } : project;
  return [...projects.filter((candidate) => candidate.path !== project.path), nextProject];
}
