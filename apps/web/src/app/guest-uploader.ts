// #914: the guest editing surface's image uploader.
//
// The server has taken guest uploads since #274 (presign and confirm both carry `guest: 'edit'`, with
// the guest count and size caps), but the guest <Editor> was never handed an uploader, so paste, drop
// and the /image command were simply absent. The uploader is the same helper the member surface uses;
// what differs is that a page-link guest does not know the page's space (#364), so the presign
// goes through the page-addressed path. A view-link guest gets nothing — the editor hides every upload
// entry point when no uploader is present, and the server would answer 401/403 anyway.
import type { Bearer } from "../data/apiClient";
import { uploadAttachment } from "../attachments/useAttachments";

export type ImageUploader = (file: File) => Promise<{ ref: string; alt: string } | null>;

export function guestImageUploader(capability: "view" | "edit", pageId: string, bearer: Bearer): ImageUploader | undefined {
  if (capability !== "edit") return undefined;
  return async (file: File) => {
    const { id, filename } = await uploadAttachment(null, pageId, bearer, file);
    return { ref: `wks-attachment:${id}`, alt: filename };
  };
}
