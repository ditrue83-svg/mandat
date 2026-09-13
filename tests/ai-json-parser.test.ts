import { afterEach, expect, it, vi } from "vitest";
import { parseAiJson } from "../src/worker/ai";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["oggetto autonomo", ' \t{ "ready": true }\r\n', { ready: true }],
  [
    "array autonomo",
    '[true, {"ready": false}, null]',
    [true, { ready: false }, null],
  ],
  ["blocco JSON completo", '```json\n{"ready":true}\n```', { ready: true }],
  [
    "blocco senza etichetta e CRLF",
    " \n```\r\n[true, null]\r\n```\t",
    [true, null],
  ],
  [
    "etichetta JSON maiuscola",
    '```JSON \t\n{"ready":true}\n```',
    { ready: true },
  ],
  [
    "delimitatori dentro una stringa",
    '```json\n{"text":"```json\\nquoted\\n```"}\n```',
    { text: "```json\nquoted\n```" },
  ],
  ["valore JSON senza schema aggiunto", "null", null],
])("accetta %s", (_name, text, expected) => {
  expect(parseAiJson(text as string)).toEqual(expected);
});

it.each([
  ["sola apertura", '```json\n{"ready":true}'],
  ["sola chiusura", '{"ready":true}\n```'],
  ["prosa prima del blocco", 'Risposta:\n```json\n{"ready":true}\n```'],
  ["prosa dopo il blocco", '```json\n{"ready":true}\n```\nFine.'],
  ["due blocchi", '```json\n{"ready":true}\n```\n```json\n{}\n```'],
  ["delimitatori inline", '```json {"ready":true}```'],
  ["etichetta diversa", '```js\n{"ready":true}\n```'],
  ["suffisso dell'etichetta", '```jsonfoo\n{"ready":true}\n```'],
  ["quattro backtick", '````json\n{"ready":true}\n````'],
  ["blocco vuoto", "```json\n\n```"],
  ["chiave non JSON", "```json\n{ready:true}\n```"],
  ["virgola finale", '```json\n{"ready":true,}\n```'],
  ["virgolette singole", "```json\n{'ready':true}\n```"],
  [
    "newline non codificato nella stringa",
    '```json\n{"text":"first\nsecond"}\n```',
  ],
  ["due valori JSON", '{"ready":true}\n{"ready":false}'],
])("rifiuta %s senza riparazioni", (_name, text) => {
  expect(() => parseAiJson(text)).toThrow(SyntaxError);
});

it.each([false, true])(
  "consegna il payload invariato a JSON.parse (blocco: %s)",
  (fenced) => {
    const payload =
      ' \t{ "text": "caffè 😀 \\u0061", "lines": "a\\r\\nb", "number": 1e2 }\t ';
    const parse = vi.spyOn(JSON, "parse");
    const input = fenced ? `\n\`\`\`json\r\n${payload}\r\n\`\`\`\n` : payload;
    const value = parseAiJson(input);
    expect(parse.mock.calls[0]).toEqual([payload]);
    expect(value).toEqual({ text: "caffè 😀 a", lines: "a\r\nb", number: 100 });
  },
);
