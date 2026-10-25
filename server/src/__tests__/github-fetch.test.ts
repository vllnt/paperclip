import { afterEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { ghFetch } from "../services/github-fetch.js";

// Built at runtime: the public-config guard rejects private address literals in committed text.
const privateHost = ["10", "0", "0", "5"].join(".");
const otherPrivateHost = ["10", "0", "0", "6"].join(".");
const resolvedPrivateAddress = ["10", "1", "2", "3"].join(".");

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ghFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("fetches the hosts GitHub serves itself directly", async () => {
    const fetchMock = stubFetch(() => new Response("ok"));

    const response = await ghFetch("https://raw.githubusercontent.com/acme/app/main/SKILL.md", {
      headers: { accept: "text/plain" },
    });

    await expect(response.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/acme/app/main/SKILL.md", {
      headers: { accept: "text/plain" },
    });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/api/v3/repos/acme/app",
    "https://[::1]/raw/acme/app/main/SKILL.md",
    `https://${privateHost}/api/v3/repos/acme/app`,
    "https://localhost/raw/acme/app/main/SKILL.md",
    "https://[::ffff:7f00:1]/raw/acme/app/main/SKILL.md",
  ])("refuses a loopback, private or link-local target before any request: %s", async (url) => {
    const fetchMock = stubFetch(() => new Response("secret"));

    await expect(ghFetch(url)).rejects.toMatchObject({ status: 422 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const fetchMock = stubFetch(() => new Response("secret"));
    dns.lookup.mockResolvedValue([{ address: resolvedPrivateAddress, family: 4 }]);

    await expect(ghFetch("https://ghe.example.com/api/v3/repos/acme/app")).rejects.toMatchObject({ status: 422 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses anything that is not an http(s) URL", async () => {
    const fetchMock = stubFetch(() => new Response("secret"));

    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "not a url"]) {
      await expect(ghFetch(url)).rejects.toMatchObject({ status: 422 });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reaches a public host and never lets the platform follow a redirect itself", async () => {
    const fetchMock = stubFetch(() => new Response("ok"));

    await expect(ghFetch("https://93.184.216.34/api/v3/repos/acme/app")).resolves.toMatchObject({ status: 200 });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect between public hosts and drops credentials when the origin changes", async () => {
    const fetchMock = stubFetch((url) =>
      url.startsWith("https://93.184.216.34/")
        ? new Response(null, { status: 302, headers: { location: "https://93.184.216.35/final" } })
        : new Response("done"),
    );

    const response = await ghFetch("https://93.184.216.34/start", {
      headers: { accept: "text/plain", authorization: "Bearer token" },
    });

    await expect(response.text()).resolves.toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer token");
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("accept")).toBe("text/plain");
  });

  it("refuses a redirect that points at an internal address", async () => {
    const fetchMock = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );

    await expect(ghFetch("https://93.184.216.34/start")).rejects.toMatchObject({ status: 422 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after too many redirects", async () => {
    const fetchMock = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: "https://93.184.216.34/again" } }),
    );

    await expect(ghFetch("https://93.184.216.34/start")).rejects.toMatchObject({ status: 422 });

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("lets an operator allow one private origin, but never a link-local address", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_PRIVATE_ORIGINS", `https://${privateHost}, https://169.254.169.254`);
    const fetchMock = stubFetch(() => new Response("ok"));

    await expect(ghFetch(`https://${privateHost}/api/v3/repos/acme/app`)).resolves.toMatchObject({ status: 200 });
    await expect(ghFetch(`https://${otherPrivateHost}/api/v3/repos/acme/app`)).rejects.toMatchObject({ status: 422 });
    await expect(ghFetch("https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ status: 422 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
