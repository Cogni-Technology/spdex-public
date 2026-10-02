import { describe, expect, it } from "vitest";
import { feedbackUrl, shareableAppUrl, sourceUrl } from "./links.js";

describe("shareableAppUrl", () => {
  it("is null when the build doesn't say where the app is published", () => {
    expect(shareableAppUrl({})).toBeNull();
    expect(shareableAppUrl({ appUrl: undefined })).toBeNull();
    expect(shareableAppUrl({ appUrl: "" })).toBeNull();
    expect(shareableAppUrl({ appUrl: "   " })).toBeNull();
  });

  it("gives the published address without its query or fragment, so a card can add #receipt=", () => {
    expect(shareableAppUrl({ appUrl: "https://example.org" })).toBe("https://example.org/");
    expect(shareableAppUrl({ appUrl: " https://Example.org/spdex/?utm=x#top " })).toBe("https://example.org/spdex/");
    expect(shareableAppUrl({ appUrl: "https://example.org:8443/app" })).toBe("https://example.org:8443/app");
  });

  it("refuses anything but https", () => {
    for (const appUrl of ["http://example.org", "javascript:alert(1)", "data:text/html,hi", "ipfs://bafy", "example.org"]) {
      expect(shareableAppUrl({ appUrl })).toBeNull();
    }
  });

  it("refuses an address with a user name or password in it", () => {
    expect(shareableAppUrl({ appUrl: "https://someone@example.org/" })).toBeNull();
    expect(shareableAppUrl({ appUrl: "https://someone:secret@example.org/" })).toBeNull();
  });

  it("refuses a name that only means something on one machine or network", () => {
    const local = [
      "https://localhost:5173",
      "https://app.localhost",
      "https://box.local",
      "https://intranet",
      "https://127.0.0.1",
      "https://0x7f.1",
      "https://10.0.0.2",
      "https://192.168.1.20",
      "https://[::1]",
      "https://[fd00::1]",
    ];
    for (const appUrl of local) expect(shareableAppUrl({ appUrl }), appUrl).toBeNull();
  });

  it("is not the canonical-origin setting, whatever that is set to", () => {
    const settings = { VITE_SPDEX_CANONICAL_ORIGIN: "https://example.org" } as never;
    expect(shareableAppUrl(settings)).toBeNull();
  });
});

describe("sourceUrl", () => {
  it("is null when the build doesn't say where the source is published", () => {
    expect(sourceUrl({})).toBeNull();
    expect(sourceUrl({ sourceUrl: "" })).toBeNull();
  });

  it("gives an https repository address as it will be pasted", () => {
    expect(sourceUrl({ sourceUrl: "https://git.example.org/spdex/spdex.git" })).toBe(
      "https://git.example.org/spdex/spdex.git",
    );
    expect(sourceUrl({ sourceUrl: "https://example.org/~someone/spdex" })).toBe("https://example.org/~someone/spdex");
  });

  it("refuses anything a shell would read as more than an address", () => {
    const risky = [
      "https://example.org/spdex;rm -rf ~",
      "https://example.org/$(whoami)",
      "https://example.org/spdex`id`",
      "https://example.org/spdex'x'",
      "https://example.org/spdex&&true",
      "https://example.org/spdex?x=1",
      "https://example.org/spdex#main",
      "https://example.org/a(b)",
    ];
    for (const value of risky) expect(sourceUrl({ sourceUrl: value }), value).toBeNull();
  });

  it("refuses what it refuses for the app: other schemes, credentials, local names", () => {
    for (const value of ["http://example.org/spdex", "git@example.org:spdex.git", "https://u:p@example.org/x", "https://localhost/x"]) {
      expect(sourceUrl({ sourceUrl: value }), value).toBeNull();
    }
  });
});

describe("feedbackUrl", () => {
  it("is null when unset or blank: the footer leaves the link out", () => {
    expect(feedbackUrl({})).toBeNull();
    expect(feedbackUrl({ feedbackUrl: "   " })).toBeNull();
  });

  it("keeps the query, which picks a tracker's form", () => {
    expect(feedbackUrl({ feedbackUrl: "https://github.com/o/r/issues/new?template=bug.yml" })).toBe(
      "https://github.com/o/r/issues/new?template=bug.yml",
    );
  });

  it("refuses anything but https on a public name", () => {
    for (const bad of [
      "http://github.com/o/r/issues",
      "javascript:alert(1)",
      "https://user:pass@github.com/o/r/issues",
      "https://localhost/issues",
      "https://printer.local/issues",
      "https://192.168.1.2/issues",
      "not a url",
    ]) {
      expect(feedbackUrl({ feedbackUrl: bad }), bad).toBeNull();
    }
  });
});
