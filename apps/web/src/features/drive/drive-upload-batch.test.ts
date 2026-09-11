import { describe, expect, it } from "vitest";
import { uploadDriveBatch } from "./drive-upload-batch";

function fileWithPath(name: string, relative: string): File {
  const file = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: relative });
  return file;
}

describe("uploadDriveBatch", () => {
  it("creates nested folders then uploads each file", async () => {
    const created: string[] = [];
    const uploaded: Array<{ name: string; folderId: string | null }> = [];
    const result = await uploadDriveBatch({
      files: [fileWithPath("a.txt", "Notes/a.txt"), fileWithPath("b.txt", "Notes/Deep/b.txt")],
      parentFolderId: "root-1",
      createFolder: async (name, parentId) => {
        created.push(`${parentId ?? "root"}/${name}`);
        return { id: `folder-${name}` };
      },
      uploadFile: async (file, folderId) => {
        uploaded.push({ name: file.name, folderId });
      },
    });
    expect(created).toEqual(["root-1/Notes", "folder-Notes/Deep"]);
    expect(uploaded).toEqual([
      { name: "a.txt", folderId: "folder-Notes" },
      { name: "b.txt", folderId: "folder-Deep" },
    ]);
    expect(result).toEqual({ fileCount: 2, folderCount: 2 });
  });

  it("uploads loose files into the current folder", async () => {
    const created: string[] = [];
    await uploadDriveBatch({
      files: [new File(["x"], "solo.txt")],
      parentFolderId: null,
      createFolder: async (name) => {
        created.push(name);
        return { id: name };
      },
      uploadFile: async () => undefined,
    });
    expect(created).toEqual([]);
  });
});
