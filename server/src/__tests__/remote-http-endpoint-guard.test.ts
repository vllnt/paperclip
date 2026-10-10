import { describe, expect, it } from "vitest";
import { assertPublicRemoteHttpEndpoint, isPrivateOrReservedIp } from "../services/remote-http-endpoint-guard.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "fe80::1",
    "febf::1",
  ])("always rejects link-local literal %s when private networking is allowed", async (address) => {
    const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      { allowPrivateNetwork: true },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["169.254.42.1", "fe80::1234"])(
    "always rejects link-local DNS answer %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://operator-endpoint.example/mcp"),
        { allowPrivateNetwork: true, lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "fd00::1"])(
    "allows intended private address %s when private networking is allowed",
    async (address) => {
      const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(url),
        { allowPrivateNetwork: true },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each([
    // ::/96: deprecated IPv4-compatible addresses, as a resolver writes them and in hex
    "::127.0.0.1",
    "::7f00:1",
    "::808:808",
    // fec0::/10: deprecated site-local
    "fec0::1",
    "feff::1",
    // Other spellings of ranges the guard already refuses
    "0:0:0:0:0:0:0:1",
    "2001:0db8::1",
    "0064:ff9b::1",
    // Anywhere in 2001:2::/32, as before, not only the /48 benchmarking block
    "2001:2:1::1",
    // Outside global unicast (2000::/3)
    "fe00::1",
    "4000::1",
  ])("rejects private or reserved IPv6 DNS answer %s", async (address) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://resolver-answer.example/mcp"),
      { lookup: async () => [{ address, family: 6 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["http://[::127.0.0.1]/mcp", "http://[fec0::1]/mcp", "http://[0:0:0:0:0:0:0:1]/mcp"])(
    "rejects reserved IPv6 literal %s",
    async (url) => {
      await expect(assertPublicRemoteHttpEndpoint(new URL(url), {}, guardError))
        .rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["::169.254.169.254", "::a9fe:a9fe"])(
    "always rejects IPv4-compatible link-local %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(`http://[${address}]/mcp`),
        { allowPrivateNetwork: true },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e", "2001:200::1"])(
    "allows public IPv6 DNS answer %s",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://public-v6.example/mcp"),
        { lookup: async () => [{ address, family: 6 }] },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it("treats a zone id and an unparsable address as not public", () => {
    expect(isPrivateOrReservedIp("fe80::1%eth0")).toBe(true);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111%eth0")).toBe(false);
    expect(isPrivateOrReservedIp("not-an-address")).toBe(true);
  });
});
