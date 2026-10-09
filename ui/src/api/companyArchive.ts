import type { CompanyArchiveInclude } from "@paperclipai/shared";

export interface CompanyArchiveExportLinkOptions {
  /** Only runs settled at or after this instant. */
  since?: Date | null;
  include: readonly CompanyArchiveInclude[];
}

export const companyArchiveApi = {
  /**
   * URL of a whole-window export download. The server follows its own page
   * cursors (`follow=true`) and answers with `Content-Disposition: attachment`,
   * so a plain link with the board session saves the file.
   */
  exportDownloadUrl: (companyId: string, options: CompanyArchiveExportLinkOptions): string => {
    const params = new URLSearchParams({ follow: "true", include: options.include.join(",") });
    if (options.since) params.set("since", options.since.toISOString());
    return `/api/companies/${encodeURIComponent(companyId)}/archive/export?${params.toString()}`;
  },
};
