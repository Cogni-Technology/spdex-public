/** A network-service address as shown: the service recognisable, its key not. */

import { describe, expect, it } from "vitest";
import { maskRpcUrl, rpcUrlMasked, serviceNameOf } from "./rpcDisplay.js";

describe("maskRpcUrl", () => {
  it("drops a user and password", () => {
    expect(maskRpcUrl("https://user:key@rpc.example.org")).toBe("https://rpc.example.org");
    expect(maskRpcUrl("https://k3yk3yk3y@rpc.example.org/")).toBe("https://rpc.example.org");
  });

  it("drops a key in the path, the query or the fragment", () => {
    expect(maskRpcUrl("https://eth-mainnet.g.alchemy.com/v2/AbCdEf0123456789xyz")).toBe("https://eth-mainnet.g.alchemy.com");
    expect(maskRpcUrl("https://rpc.example.org/?apikey=0123456789abcdef")).toBe("https://rpc.example.org");
    expect(maskRpcUrl("https://rpc.example.org/#token")).toBe("https://rpc.example.org");
  });

  it("cuts a key in a subdomain: a long label, or a shorter one mixing letters and digits", () => {
    expect(maskRpcUrl("https://abcdefghijklmnopqrst.rpc.example.org")).toBe("https://abcd….rpc.example.org");
    expect(maskRpcUrl("https://a1b2c3d4e5f6.rpc.example.org")).toBe("https://a1b2….rpc.example.org");
    // Short, or long without digits under 16: a name, kept.
    expect(maskRpcUrl("https://eth-mainnet.example.org")).toBe("https://eth-mainnet.example.org");
    expect(maskRpcUrl("https://mainnet2.example.org")).toBe("https://mainnet2.example.org");
    expect(maskRpcUrl("https://ethereumrpcnode.example.org")).toBe("https://ethereumrpcnode.example.org");
    expect(maskRpcUrl("https://ethereumrpcnodes.example.org")).toBe("https://ethe….example.org");
  });

  it("keeps the scheme and a port, and an IP address as it is", () => {
    expect(maskRpcUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    expect(maskRpcUrl("ws://localhost:8546/path")).toBe("ws://localhost:8546");
    expect(maskRpcUrl("http://[::1]:8545/")).toBe("http://[::1]:8545");
  });

  it("shows nothing of something that isn't a URL", () => {
    expect(maskRpcUrl("not a url with a key 0123456789abcdef")).toBe("…");
    expect(maskRpcUrl("")).toBe("…");
  });
});

describe("rpcUrlMasked", () => {
  it("says whether SHOW has anything to show", () => {
    expect(rpcUrlMasked("http://127.0.0.1:8545")).toBe(false);
    expect(rpcUrlMasked("http://127.0.0.1:8545/")).toBe(false);
    expect(rpcUrlMasked("https://eth-mainnet.g.alchemy.com/v2/key")).toBe(true);
    expect(rpcUrlMasked("https://user:pw@rpc.example.org")).toBe(true);
  });
});

describe("serviceNameOf", () => {
  it("names the built-in service as that, and any other by its masked address, never its key", () => {
    expect(serviceNameOf({ url: "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnop", source: "bundled" })).toBe("the built-in service");
    expect(serviceNameOf({ url: null, source: "bundled" })).toBe("the built-in service");
    expect(serviceNameOf({ url: "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnop", source: "user" })).toBe("https://eth-mainnet.g.alchemy.com");
    expect(serviceNameOf({ url: "https://ethereum-rpc.publicnode.com", source: "fallback" })).toBe("https://ethereum-rpc.publicnode.com");
  });
});
