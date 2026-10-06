export const PLUGIN_ID = "vllnt.paperclip-github";
export const PAGE_PATH = "/github-projects";
export interface AppIdentity { permissions?: Record<string, string>; id: string; slug: string; name: string; owner?: string; settingsUrl?: string; issuesWrite?: boolean }
export interface Credentials extends AppIdentity { privateKey: string }
export interface AllowedOwner { id: number; login: string }
export interface Installation { accountId?: number; accountType?: "Organization" | "User"; permissions?: Record<string, string>; id: number; login: string; suspended: boolean; issuesWrite?: boolean; settingsUrl?: string }
export interface Repository { ownerId?: number; permissions?: Record<string, string>; id: number; name: string; fullName: string; url: string; installationId: number; owner: string; private: boolean; issuesWrite?: boolean }
export interface TaskAssociation { paperclipTask?: { id: string; identifier: string | null; status: string }; paperclipTaskError?: string }
export interface GitHubIssue extends TaskAssociation { id: number; number: number; title: string; state: string; url: string; repository: string; updatedAt: string; assignees: string[]; body?: string; labels?: string[]; stateReason?: string | null }
export interface Catalog { app: AppIdentity; installations: Installation[]; repositories: Repository[]; warnings: string[]; truncated: boolean }
export interface IssuePage { issues: GitHubIssue[]; nextPage: number | null; repository: string }
export interface SetupStart { state: string; actionUrl: string; manifest: Record<string, unknown> }
export interface Status { configured: boolean; app: AppIdentity | null; allowedOwners?: string[] }

export interface LinkedProject { id: string; name: string }
export interface TaskRepository extends Repository { projects: LinkedProject[] }
export interface TaskRepositories { configured: boolean; repositories: TaskRepository[]; linkedCount: number; warnings: string[] }

export interface AutomationRule {
  id: string;
  enabled: boolean;
  name: string;
  if: { repository?: string; assignee?: string; label?: string; state?: "open" | "closed" };
  then: { agentId?: string; status?: "todo" | "backlog" | "in_review" | "blocked"; priority?: "low" | "medium" | "high" | "critical"; wake?: boolean };
}
export interface SyncSettings { enabled: boolean; rules: AutomationRule[] }
export interface SyncReport { at: string; imported: number; updated: number; warnings: string[] }
