export const NATIVE_DOCUMENT_COMMAND_EVENT = "helix:native-document-command";

export type NativeDocumentSmartChipKind = "person" | "doc" | "file" | "event";

export type NativeDocumentCommandEventDetail =
  | { readonly command: "find" }
  | { readonly command: "cut" }
  | { readonly command: "copy" }
  | { readonly command: "paste" }
  | { readonly command: "paste-plain" }
  | { readonly command: "insert-link" }
  | { readonly command: "insert-image" }
  | { readonly command: "insert-table" }
  | { readonly command: "insert-equation" }
  | { readonly command: "insert-toc" }
  | { readonly command: "insert-bookmark" }
  | { readonly command: "insert-cross-reference" }
  | { readonly command: "insert-field" }
  | { readonly command: "open-smart-chip-picker" }
  | { readonly command: "insert-page-break" }
  | { readonly command: "insert-footnote" }
  | { readonly command: "refresh-fields" }
  | { readonly command: "insert-smart-chip"; readonly kind: NativeDocumentSmartChipKind };
