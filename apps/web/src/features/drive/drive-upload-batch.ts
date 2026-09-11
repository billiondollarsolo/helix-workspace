export async function uploadDriveBatch(input: {
  readonly files: readonly File[];
  readonly parentFolderId: string | null;
  readonly createFolder: (
    name: string,
    parentId: string | null,
  ) => Promise<{ readonly id: string }>;
  readonly uploadFile: (file: File, folderId: string | null) => Promise<unknown>;
}): Promise<{ readonly fileCount: number; readonly folderCount: number }> {
  const folders = new Map<string, string | null>();
  folders.set("", input.parentFolderId);
  let folderCount = 0;
  for (const file of input.files) {
    const relative = (
      typeof file.webkitRelativePath === "string" && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : file.name
    )
      .replaceAll("\\", "/")
      .split("/")
      .filter((part) => part.length > 0);
    relative.pop();
    let parent = input.parentFolderId;
    let path = "";
    for (const segment of relative) {
      path = path.length === 0 ? segment : `${path}/${segment}`;
      const existing = folders.get(path);
      if (existing !== undefined) {
        parent = existing;
        continue;
      }
      const created = await input.createFolder(segment, parent);
      folders.set(path, created.id);
      parent = created.id;
      folderCount += 1;
    }
    await input.uploadFile(file, parent);
  }
  return { fileCount: input.files.length, folderCount };
}
