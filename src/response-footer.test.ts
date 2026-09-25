import assert from "node:assert/strict";
import test from "node:test";
import { ResponseFooter, allowsResponseFooter, responseFooter, stripResponseFooters, withoutResponseFooters } from "./response-footer.js";

function fixture(phase: string | undefined = "final_answer", tools = false, status = "completed", text = "안녕하세요. 🍎") {
  const part = { type: "output_text", text, annotations: [] };
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

test("Codex backend empty completion output uses the preceding final item and its actual index", async () => {
  const { events } = fixture();
  // Reasoning output already finished before the visible message at index 2.
  const shifted = events.map((event) => {
    const value = JSON.parse(JSON.stringify(event));
    if (typeof value.output_index === "number") value.output_index += 2;
    if (value.type === "response.completed") value.response.output = [];
    return value;
  });
  const input = shifted.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const output = await transform(input, undefined, 1);
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const expected = `안녕하세요. 🍎${responseFooter("served-model", "low")}`;
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
  assert.equal(result.find((e) => e.type === "response.output_text.done").text, expected);
  assert.equal(result.find((e) => e.type === "response.content_part.done").part.text, expected);
  assert.equal(result.find((e) => e.type === "response.output_item.done").item.content[0].text, expected);
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").at(-1).output_index, 2);
  assert.deepEqual(result.at(-1).response.output, []);
  assert.deepEqual(result.map((e) => e.sequence_number), result.map((_, index) => index));
});

test("empty completion output still excludes commentary, incomplete responses and earlier tool calls", async () => {
  for (const phase of ["commentary", "final_answer"]) {
    const { events } = fixture(phase);
    const copied = events.map((e) => JSON.parse(JSON.stringify(e)));
    copied.at(-1).response.output = [];
    if (phase === "final_answer") copied.unshift({ type: "response.output_item.added", output_index: 9, item: { type: "function_call" } });
    const input = copied.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    assert.equal(await transform(input), input);
  }
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

test("footer marks only a confirmed model mismatch and removes old mismatch trailers", () => {
  const mismatch = responseFooter("served-model", "low", "requested-model");
  assert.equal(mismatch, "\n\n— 모델: served-model · 요청 effort: low · 요청 모델: requested-model ≠");
  assert.equal(stripResponseFooters(`Answer${mismatch}`), "Answer");
  assert.equal(responseFooter("requested-model-20260901", "low", "requested-model"),
    "\n\n— 모델: requested-model-20260901 · 요청 effort: low");
});

test("model-written and repeated footers are replaced with one authoritative footer in every SSE view", async () => {
  const expected = `I have an apple.${responseFooter("served-model", "low")}`;
  for (const emptyOutput of [true, false]) {
    for (const suffix of [responseFooter("served-model", "low"), responseFooter("old-model", "xhigh"),
      responseFooter("old-model", "high").repeat(2)]) {
      const { events } = fixture("final_answer", false, "completed", `I have an apple.${suffix}`);
      const input = events.map((event) => {
        const e = JSON.parse(JSON.stringify(event));
        if (emptyOutput && e.type === "response.completed") e.response.output = [];
        return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      }).join("");
      const once = await transform(input, undefined, 1);
      for (const output of [once, await transform(once)]) {
        const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
        assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
        assert.equal(result.find((e) => e.type === "response.output_text.done").text, expected);
        assert.equal(result.find((e) => e.type === "response.content_part.done").part.text, expected);
        assert.equal(result.find((e) => e.type === "response.output_item.done").item.content[0].text, expected);
        assert.deepEqual(result.map((e) => e.sequence_number), result.map((_, index) => index));
        if (!emptyOutput) assert.equal(result.at(-1).response.output[0].content[0].text, expected);
      }
    }
  }
});

test("footer detection spans separate delta events without delaying ordinary text", async () => {
  const text = `Answer${responseFooter("stale-model", "high")}`;
  const { events } = fixture("final_answer", false, "completed", text);
  const expanded = events.flatMap<Record<string, unknown>>((event) => event.type === "response.output_text.delta"
    ? [...text].map((delta) => ({ ...event, delta })) : [event]);
  const input = expanded.map((e, sequence_number) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join("");
  const output = await transform(input);
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), `Answer${responseFooter("served-model", "low")}`);
});

test("footer examples inside an answer and incomplete responses retain their text", async () => {
  for (const status of ["completed", "incomplete"]) {
    const text = `Example:${responseFooter("example-model", "high")}\n\nThis line explains the example.`;
    const input = fixture("final_answer", false, status, text).stream;
    const output = await transform(input);
    const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    const expected = text + (status === "completed" ? responseFooter("served-model", "low") : "");
    assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
    assert.equal(result.find((e) => e.type === "response.output_text.done").text, expected);
  }
  const text = `Answer${responseFooter("model", "high")}`;
  const output = await transform(fixture("final_answer", false, "incomplete", text).stream);
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), text);
});

test("an error before text.done releases held text without claiming a completed footer", async () => {
  const text = `Partial answer${responseFooter("unconfirmed-model", "high")}`;
  const { events } = fixture("final_answer", false, "completed", text);
  const partial = [...events.slice(0, 4), { type: "error", code: "synthetic_error", sequence_number: 4 }];
  const output = await transform(partial.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), text);
  assert.equal(result.at(-1).type, "error");
  assert.deepEqual(result.map((e) => e.sequence_number), result.map((_, index) => index));
});

test("JSON footer normalization and history cleanup preserve users, tools and non-trailer examples", async () => {
  const old = responseFooter("old-model", "high");
  const response = fixture("final_answer", false, "completed", `Answer${old}${old}`).events.at(-1)!.response;
  const output = JSON.parse(await transform(JSON.stringify(response), "application/json"));
  assert.equal(output.output[0].content[0].text, `Answer${responseFooter("served-model", "low")}`);
  const example = `Here is an example:${old}\n\nMore explanation.`;
  const body = { input: [
    { role: "assistant", content: `Answer${old}${old}` },
    { role: "assistant", content: [{ type: "output_text", text: `Other answer${old}` }] },
    { role: "assistant", content: example },
    { role: "user", content: `Discuss this:${old}` },
    { type: "function_call_output", output: old },
  ] };
  const cleaned = withoutResponseFooters(body);
  assert.equal(cleaned.input[0].content, "Answer");
  assert.equal(cleaned.input[1].content[0].text, "Other answer");
  assert.equal(cleaned.input[2].content, example);
  assert.deepEqual(cleaned.input.slice(3), body.input.slice(3));
  assert.equal(body.input[0]!.content, `Answer${old}${old}`);
  assert.equal(stripResponseFooters(`\`\`\`\n${old}\n\`\`\``), `\`\`\`\n${old}\n\`\`\``);
});
