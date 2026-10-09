import type {
  BrowserProfile,
  BrowserProfilesOverview,
  BrowserSignInInput,
  BrowserSignInState,
  CompanyBrowserSettings,
  CreateBrowserProfile,
  UpdateBrowserProfile,
} from "@paperclipai/shared";
import { api } from "./client";

function profilePath(companyId: string, profileId: string): string {
  return `/companies/${companyId}/browser/profiles/${profileId}`;
}

/** Board-only client for the company's shared browser profiles and sign-in view. */
export const browserProfilesApi = {
  overview: (companyId: string) =>
    api.get<BrowserProfilesOverview>(`/companies/${companyId}/browser/overview`, {
      cache: "no-store",
    }),
  saveSettings: (companyId: string, settings: CompanyBrowserSettings) =>
    api.put<CompanyBrowserSettings>(
      `/companies/${companyId}/browser/settings`,
      settings,
    ),
  create: (companyId: string, input: CreateBrowserProfile) =>
    api.post<BrowserProfile>(`/companies/${companyId}/browser/profiles`, input),
  update: (companyId: string, profileId: string, input: UpdateBrowserProfile) =>
    api.patch<BrowserProfile>(profilePath(companyId, profileId), input),
  suspend: (companyId: string, profileId: string) =>
    api.post<BrowserProfile>(`${profilePath(companyId, profileId)}/suspend`, {}),
  resume: (companyId: string, profileId: string) =>
    api.post<BrowserProfile>(`${profilePath(companyId, profileId)}/resume`, {}),
  remove: (companyId: string, profileId: string) =>
    api.delete<{ ok: true }>(profilePath(companyId, profileId)),
  startSignIn: (companyId: string, profileId: string, startUrl?: string) =>
    api.post<BrowserSignInState>(
      `${profilePath(companyId, profileId)}/signin`,
      startUrl ? { startUrl } : {},
    ),
  signInState: (companyId: string, profileId: string) =>
    api.get<BrowserSignInState>(`${profilePath(companyId, profileId)}/signin/state`, {
      cache: "no-store",
    }),
  /** URL of the live page image. The caller passes a changing `cacheBust` to force a reload. */
  signInFrameUrl: (
    companyId: string,
    profileId: string,
    cacheBust: number | string,
  ): string =>
    `/api${profilePath(companyId, profileId)}/signin/frame?t=${encodeURIComponent(String(cacheBust))}`,
  sendSignInInput: (
    companyId: string,
    profileId: string,
    input: BrowserSignInInput,
  ) =>
    api.post<BrowserSignInState>(
      `${profilePath(companyId, profileId)}/signin/input`,
      input,
    ),
  endSignIn: (companyId: string, profileId: string) =>
    api.post<BrowserProfile>(`${profilePath(companyId, profileId)}/signin/end`, {}),
};
