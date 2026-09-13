import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { fetchOfficial, fetchOfficialResponse } from "../src/sources/common";

const url = "https://www.simap.ch/api/invented-receipt-fixture";
const hosts = ["www.simap.ch"];
const sha = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stream(chunks: Uint8Array[]) {
  let next = 0;
  const cancel = vi.fn();
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (next === chunks.length) controller.close();
      else controller.enqueue(chunks[next++]);
    },
  );
  const body = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  return { body, pull, cancel };
}

test("Receipt preserves UTF-8 bytes across chunk boundaries and records completion time before decoding", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T15:00:00.000Z"));
  const text = "è 🌳 e\u0301\n";
  const bytes = Buffer.from(text, "utf8");
  const input = stream([
    bytes.subarray(0, 1),
    bytes.subarray(1, 5),
    bytes.subarray(5),
  ]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(input.body)));
  const receipt = await fetchOfficialResponse(url, hosts);
  assert.equal(receipt.url, url);
  assert.equal(receipt.receivedAt, "2026-09-13T15:00:00.000Z");
  assert.ok(receipt.body instanceof Uint8Array);
  assert.deepEqual(Buffer.from(receipt.body), bytes);
  assert.equal(receipt.bodySha256, sha(bytes));
  assert.equal(receipt.bodyByteLength, bytes.byteLength);
  assert.equal(Buffer.from(receipt.body).toString("utf8"), text);
  assert.equal(input.body.locked, false);
});

test("Invalid UTF-8 stays byte-exact in the receipt while the legacy wrapper keeps Buffer decoding", async () => {
  const bytes = Uint8Array.from([0xff, 0xc3, 0x28, 0x00, 0xed, 0xa0, 0x80]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(stream([bytes.subarray(0, 2), bytes.subarray(2)]).body),
      ),
    ),
  );
  const receipt = await fetchOfficialResponse(url, hosts);
  assert.deepEqual(Array.from(receipt.body), Array.from(bytes));
  assert.equal(receipt.bodySha256, sha(bytes));
  assert.equal(receipt.bodyByteLength, 7);
  const decoded = await fetchOfficial(url, hosts);
  assert.equal(decoded, Buffer.from(bytes).toString("utf8"));
  assert.notEqual(sha(Buffer.from(decoded, "utf8")), receipt.bodySha256);
});

test("Keeps the existing host, headers, timeout, no-store and redirect rejection policy", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await fetchOfficialResponse(url, hosts);
  assert.equal(fetchMock.mock.calls.length, 1);
  const [requestedUrl, options] = fetchMock.mock.calls[0];
  assert.equal(requestedUrl, url);
  assert.deepEqual(options.headers, {
    Accept: "application/json, application/xml, text/xml",
    "User-Agent": "MandatRadar/0.1",
  });
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  const redirectError = new TypeError("fetch failed: unexpected redirect");
  fetchMock.mockRejectedValueOnce(redirectError);
  await assert.rejects(
    fetchOfficialResponse(url, hosts),
    (error) => error === redirectError,
  );
  assert.equal(fetchMock.mock.calls.length, 2);
});

test("Forbidden protocols, credentials and hosts are rejected before fetch", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const forbidden of [
    "http://www.simap.ch/source",
    "https://www.simap.ch.evil.example/source",
    "https://other.example/source",
    "https://user:secret@www.simap.ch/source",
  ])
    await assert.rejects(
      fetchOfficialResponse(forbidden, hosts),
      /URL della fonte non consentito/,
    );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("HTTP failure and a missing body do not produce receipts", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await assert.rejects(
    fetchOfficialResponse(url, hosts),
    /Fonte www\.simap\.ch: HTTP 503/,
  );
  await assert.rejects(fetchOfficialResponse(url, hosts), /Risposta vuota/);
});

test("Oversized content-length cancels the body before reading, including the default limit", async () => {
  const declared = stream([Uint8Array.of(1)]);
  const defaultLimit = stream([Uint8Array.of(1)]);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(declared.body, { headers: { "content-length": "4" } }),
      )
      .mockResolvedValueOnce(
        new Response(defaultLimit.body, {
          headers: { "content-length": "12000001" },
        }),
      ),
  );
  await assert.rejects(
    fetchOfficialResponse(url, hosts, 3),
    /Risposta della fonte troppo grande/,
  );
  await assert.rejects(
    fetchOfficialResponse(url, hosts),
    /Risposta della fonte troppo grande/,
  );
  for (const input of [declared, defaultLimit]) {
    assert.equal(input.pull.mock.calls.length, 0);
    assert.equal(input.cancel.mock.calls.length, 1);
    assert.equal(input.body.locked, false);
  }
});

test("Progressive byte limit cancels at the first overflowing chunk without reading the tail", async () => {
  const input = stream([
    Uint8Array.of(1, 2),
    Uint8Array.of(3, 4),
    Uint8Array.of(5, 6),
  ]);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(input.body, { headers: { "content-length": "1" } }),
      ),
  );
  await assert.rejects(
    fetchOfficialResponse(url, hosts, 3),
    /Risposta della fonte troppo grande/,
  );
  assert.equal(input.pull.mock.calls.length, 2);
  assert.equal(input.cancel.mock.calls.length, 1);
  assert.equal(input.body.locked, false);
});

test("Hashes the body exposed by Fetch rather than the encoded content-length", async () => {
  const exposed = Buffer.from("🌳", "utf8");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(stream([exposed]).body, {
        // A Fetch client may expose decompressed bytes with original headers.
        headers: { "content-length": "1", "content-encoding": "gzip" },
      }),
    ),
  );
  const receipt = await fetchOfficialResponse(url, hosts, 4);
  assert.equal(receipt.bodyByteLength, 4);
  assert.equal(receipt.bodySha256, sha(exposed));
  assert.deepEqual(Buffer.from(receipt.body), exposed);
});

test("Stream errors propagate without partial receipts; an actual empty stream remains compatible", async () => {
  const failure = new Error("Read interrupted");
  const broken = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.error(failure);
      },
    },
    { highWaterMark: 0 },
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(broken))
      .mockResolvedValueOnce(new Response(stream([]).body)),
  );
  await assert.rejects(
    fetchOfficialResponse(url, hosts),
    (error) => error === failure,
  );
  assert.equal(broken.locked, false);
  const empty = await fetchOfficialResponse(url, hosts, 0);
  assert.equal(empty.bodyByteLength, 0);
  assert.equal(empty.bodySha256, sha(new Uint8Array()));
  assert.equal(empty.body.length, 0);
});
