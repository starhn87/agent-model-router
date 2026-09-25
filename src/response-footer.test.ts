import assert from "node:assert/strict";
import test from "node:test";
import { ResponseFooter, allowsResponseFooter, responseFooter } from "./response-footer.js";

function fixture(phase: string | undefined = "final_answer", tools = false, status = "completed") {
  const part = { type: "output_text", text: "안녕하세요. 🍎", annotations: [] };
  const item = { type: "message", role: "assistant", id: "msg_1", status: "completed", phase, content: [part] };
  const events = [
    { type: "response.created", response: { model: "requested-model" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { ...part, text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: part.text },
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: part.text },
    { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: item.id, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: status === "completed" ? "response.completed" : "response.incomplete", response: {
      status, model: "served-model", output: [item, ...(tools ? [{ type: "function_call", name: "test" }] : [])],
    } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  return { events, stream: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") };
}

async function transform(text: string, contentType: string | undefined = "text/event-stream", split = 7): Promise<string> {
  const stream = new ResponseFooter(contentType, "low");
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += split) stream.write(bytes.subarray(i, i + split));
  stream.end();
  await new Promise<void>((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  return Buffer.concat(chunks).toString();
}

test("final SSE streams original text immediately and appends served model consistently before done", async () => {
  const { stream: input } = fixture();
  const output = await transform(input, undefined, 1);
  const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const expected = `안녕하세요. 🍎${responseFooter("served-model", "low")}`;
  assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
  assert.equal(events.find((e) => e.type === "response.output_text.done").text, expected);
  assert.equal(events.find((e) => e.type === "response.content_part.done").part.text, expected);
  assert.equal(events.find((e) => e.type === "response.output_item.done").item.content[0].text, expected);
  assert.equal(events.at(-1).response.output[0].content[0].text, expected);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, index) => index));
  const stream = new ResponseFooter("text/event-stream", "low");
  let received = "";
  stream.on("data", (chunk) => { received += chunk.toString(); });
  const delta = 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n';
  stream.write(delta);
  assert.equal(received, delta);
  stream.destroy();
});

test("commentary, tools, errors and incomplete responses stay byte-for-byte unchanged", async () => {
  for (const sample of [fixture("commentary").stream, fixture(undefined, true).stream, fixture("final_answer", false, "incomplete").stream,
    'data: {bad json}\n\n', 'data: {"type":"error"}\n\n']) {
    assert.equal(await transform(sample), sample);
  }
});

test("JSON final answers are amended while structured output and title requests are excluded", async () => {
  const response = fixture().events.at(-1)!.response;
  const output = JSON.parse(await transform(JSON.stringify(response), "application/json"));
  assert.match(output.output[0].content[0].text, /모델: served-model · 요청 effort: low$/);
  assert.equal(allowsResponseFooter({ text: { format: { type: "json_schema" } } }), false);
  assert.equal(allowsResponseFooter({ input: [{ role: "user", content: "Generate a concise, single-line task title for this" }] }), false);
  assert.equal(allowsResponseFooter({}), true);
});

test("CRLF, missing final newline and oversized unknown data are preserved or handled safely", async () => {
  const crlf = await transform(fixture().stream.replaceAll("\n", "\r\n"));
  assert.match(crlf, /모델: served-model/);
  const missingBoundary = fixture().stream.trimEnd();
  // No completed SSE frame: don't manufacture a successful answer.
  assert.equal(await transform(missingBoundary), missingBoundary);
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  assert.equal(await transform(oversized, undefined, oversized.length), oversized);
  assert.equal(responseFooter("<bad>", "<bad>"), "\n\n— 모델: 확인 불가 · 요청 effort: 기본값");
});
