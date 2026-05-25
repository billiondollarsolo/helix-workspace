export const NATIVE_DOCUMENT_COMMAND_EVENT = "helix:native-document-command";

export type NativeDocumentSmartChipKind = "person" | "doc" | "event";

export type NativeDocumentCommandEventDetail =
  | { readonly command: "find" }
  | { readonly command: "insert-toc" }
  | { readonly command: "insert-bookmark" }
  | { readonly command: "refresh-fields" }
  | { readonly command: "insert-smart-chip"; readonly kind: NativeDocumentSmartChipKind };
