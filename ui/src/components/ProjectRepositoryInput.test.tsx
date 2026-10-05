// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRepositoryInput, repositoryOptionsKey } from "./ProjectRepositoryInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/router", () => ({ useActiveCompanyPrefix: () => "GIT" }));
vi.mock("@/api/projects", () => ({ projectsApi: { repositoryOptions: vi.fn() } }));
vi.mock("./RepositoryEditor", () => ({ RepositoryEditor: ({ available, state, onChange, onConnect }: any) => <div>
  <span>{state}</span>{available?.map((repo: any) => <button key={repo.id} onClick={() => onChange([repo])}>{repo.fullName}</button>)}
  <button onClick={onConnect}>Connection settings</button>
</div> }));
afterEach(() => { document.body.innerHTML = ""; });

describe("native plugin repository picker", () => {
  it("uses the connected catalog and passes repo identity and plugin setup path to the native form", async () => {
    const repo = { id: "42", fullName: "my-org/my-repo", url: "https://github.com/my-org/my-repo", connections: ["My App"] };
    const client = new QueryClient();
    client.setQueryData(repositoryOptionsKey("company"), { repositories: [repo], connectionCount: 1, failedConnectionCount: 0, setupPath: "/github-projects", warnings: ["One installation is suspended"] });
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    const change = vi.fn(), connect = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}><ProjectRepositoryInput companyId="company" selected={[]} onChange={change} onConnect={connect} /></QueryClientProvider>));
    expect(container.textContent).toContain("ready");
    expect(container.textContent).toContain("my-org/my-repo");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("suspended");
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(change).toHaveBeenCalledWith([repo]);
    await act(async () => (Array.from(container.querySelectorAll('button')).find(button => button.textContent === "Connection settings")!).click());
    expect(connect).toHaveBeenCalledWith("/GIT/github-projects");
    await act(async () => root.unmount()); client.clear();
  });
});
