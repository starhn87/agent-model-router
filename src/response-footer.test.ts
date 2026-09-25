import assert from "node:assert/strict";
import test from "node:test";
import { ResponseFooter, allowsResponseFooter, responseFooter, responseRoute, stripResponseFooters, withoutResponseFooters } from "./response-footer.js";

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

async function transform(text: string, contentType: string | undefined = "text/event-stream", split = 7, requestedModel?: string): Promise<string> {
  const stream = new ResponseFooter(contentType, "low", requestedModel);
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += split) stream.write(bytes.subarray(i, i + split));
  stream.end();
  await new Promise<void>((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  return Buffer.concat(chunks).toString();
}

test("selected route appears before the first streamed answer and is removed from later input", async () => {
  const input = fixture().stream;
  const output = await transform(input, "text/event-stream", 1, "requested-model");
  const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const expected = responseRoute("requested-model", "low") + "안녕하세요. 🍎" + responseFooter("served-model", "low", "requested-model");
  assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
  assert.equal(events.find((e) => e.type === "response.output_text.delta").delta.startsWith(responseRoute("requested-model", "low")), true);
  assert.equal(events.find((e) => e.type === "response.output_text.done").text, expected);
  assert.equal(events.find((e) => e.type === "response.content_part.done").part.text, expected);
  assert.equal(events.find((e) => e.type === "response.output_item.done").item.content[0].text, expected);
  assert.equal(events.at(-1).response.output[0].content[0].text, expected);
  assert.equal(withoutResponseFooters({ input: [{ role: "assistant", content: expected }] }).input[0].content, "안녕하세요. 🍎");
});

test("matching served model keeps only the opening route", async () => {
  for (const stale of ["", responseFooter("stale-model", "high", "requested-model")]) {
    const { events } = fixture("final_answer", false, "completed", `안녕하세요. 🍎${stale}`);
    const input = events.map((event) => {
      const value = JSON.parse(JSON.stringify(event));
      if (value.type === "response.completed") value.response.model = "requested-model";
      return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
    }).join("");
    const output = await transform(input, "text/event-stream", 1, "requested-model");
    const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    const expected = `${responseRoute("requested-model", "low")}안녕하세요. 🍎`;
    assert.equal(result.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), expected);
    assert.equal(result.find((event) => event.type === "response.output_text.done").text, expected);
    assert.equal(result.at(-1).response.output[0].content[0].text, expected);
    assert.doesNotMatch(expected, /— 모델:/);
  }
});

test("route line is released with the first text delta before completion", () => {
  const stream = new ResponseFooter("text/event-stream", "low", "requested-model");
  let visible = "";
  stream.on("data", (chunk) => { visible += chunk.toString(); });
  for (const event of fixture().events.slice(0, 4))
    stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  assert.match(visible, /선택 모델: requested-model · 요청 effort: low/);
  assert.doesNotMatch(visible, /모델: served-model/);
  stream.destroy();
});

test("multiple text parts announce the route once and keep the settled footer last", async () => {
  const { events } = fixture("final_answer", false, "completed", "First");
  const second = { type: "output_text", text: "Second", annotations: [] };
  const extra = [
    { type: "response.content_part.added", output_index: 0, content_index: 1, item_id: "msg_1", part: { ...second, text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "msg_1", delta: "Second" },
    { type: "response.output_text.done", output_index: 0, content_index: 1, item_id: "msg_1", text: "Second" },
    { type: "response.content_part.done", output_index: 0, content_index: 1, item_id: "msg_1", part: second },
  ];
  const expanded = [...events.slice(0, 6), ...extra, ...events.slice(6)].map((event, sequence_number) => {
    const value = JSON.parse(JSON.stringify({ ...event, sequence_number }));
    if (value.type === "response.output_item.done") value.item.content.push(second);
    if (value.type === "response.completed") value.response.output[0].content.push(second);
    return value;
  });
  const input = expanded.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const output = await transform(input, "text/event-stream", 5, "requested-model");
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const route = responseRoute("requested-model", "low");
  const footer = responseFooter("served-model", "low", "requested-model");
  const deltas = result.filter((event) => event.type === "response.output_text.delta");
  assert.equal(deltas.filter((event) => event.content_index === 0).map((event) => event.delta).join(""), route + "First");
  assert.equal(deltas.filter((event) => event.content_index === 1).map((event) => event.delta).join(""), "Second" + footer);
  assert.equal(result.at(-1).response.output[0].content[0].text, route + "First");
  assert.equal(result.at(-1).response.output[0].content[1].text, "Second" + footer);
  const cleaned = withoutResponseFooters({ input: [{ role: "assistant", content: [
    { type: "output_text", text: route + "First" }, { type: "output_text", text: "Second" + footer },
  ] }] });
  assert.deepEqual(cleaned.input[0].content, [
    { type: "output_text", text: "First" }, { type: "output_text", text: "Second" },
  ]);
});

test("tool and incomplete steps keep the route line without claiming a final model", async () => {
  for (const [tools, status] of [[true, "completed"], [false, "incomplete"]] as const) {
    const output = await transform(fixture("final_answer", tools, status, "Working").stream,
      "text/event-stream", 7, "requested-model");
    const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    const expected = responseRoute("requested-model", "low") + "Working";
    assert.equal(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), expected);
    assert.equal(events.find((event) => event.type === "response.output_text.done").text, expected);
    assert.equal(events.at(-1).response.output[0].content[0].text, expected);
    assert.doesNotMatch(expected, /— 모델:/);
  }
});

test("final SSE without a selected model leaves no footer", async () => {
  const { stream: input } = fixture();
  const output = await transform(input, undefined, 1);
  const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const expected = "안녕하세요. 🍎";
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
  const output = await transform(input, undefined, 1, "requested-model");
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  const expected = `> ✳️ 선택 모델: requested-model · 요청 effort: low\n\n---\n\n안녕하세요. 🍎${responseFooter("served-model", "low", "requested-model")}`;
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
  const output = JSON.parse(await transform(JSON.stringify(response), "application/json", 7, "requested-model"));
  assert.match(output.output[0].content[0].text, /모델: served-model · 요청 effort: low · 요청 모델: requested-model ≠$/);
  assert.equal(allowsResponseFooter({ text: { format: { type: "json_schema" } } }), false);
  assert.equal(allowsResponseFooter({ input: [{ role: "user", content: "Generate a concise, single-line task title for this" }] }), false);
  assert.equal(allowsResponseFooter({}), true);
});

test("CRLF, missing final newline and oversized unknown data are preserved or handled safely", async () => {
  const crlf = await transform(fixture().stream.replaceAll("\n", "\r\n"), undefined, 7, "requested-model");
  assert.match(crlf, /모델: served-model/);
  const missingBoundary = fixture().stream.trimEnd();
  // No completed SSE frame: don't manufacture a successful answer.
  assert.equal(await transform(missingBoundary), missingBoundary);
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  assert.equal(await transform(oversized, undefined, oversized.length), oversized);
  assert.equal(responseFooter("<bad>", "<bad>", "requested-model"), "");
});

test("footer marks only a confirmed model mismatch and removes old mismatch trailers", () => {
  const mismatch = responseFooter("served-model", "low", "requested-model");
  assert.equal(mismatch, "\n\n— 모델: served-model · 요청 effort: low · 요청 모델: requested-model ≠");
  assert.equal(stripResponseFooters(`Answer${mismatch}`), "Answer");
  assert.equal(responseFooter("requested-model-20260901", "low", "requested-model"),
    "");
  assert.equal(responseFooter("requested-model", "low", "requested-model"), "");
  assert.equal(responseFooter("served-model", "low"), "");
});

test("model-written and repeated footers are replaced with one authoritative footer in every SSE view", async () => {
  const expected = `${responseRoute("requested-model", "low")}I have an apple.${responseFooter("served-model", "low", "requested-model")}`;
  for (const emptyOutput of [true, false]) {
    for (const suffix of [responseFooter("served-model", "low", "requested-model"), responseFooter("old-model", "xhigh", "requested-model"),
      responseFooter("old-model", "high", "requested-model").repeat(2)]) {
      const { events } = fixture("final_answer", false, "completed", `I have an apple.${suffix}`);
      const input = events.map((event) => {
        const e = JSON.parse(JSON.stringify(event));
        if (emptyOutput && e.type === "response.completed") e.response.output = [];
        return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      }).join("");
      const once = await transform(input, undefined, 1, "requested-model");
      for (const output of [once, await transform(once, undefined, 7, "requested-model")]) {
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
  const text = `Answer${responseFooter("stale-model", "high", "requested-model")}`;
  const { events } = fixture("final_answer", false, "completed", text);
  const expanded = events.flatMap<Record<string, unknown>>((event) => event.type === "response.output_text.delta"
    ? [...text].map((delta) => ({ ...event, delta })) : [event]);
  const input = expanded.map((e, sequence_number) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join("");
  const output = await transform(input, undefined, 7, "requested-model");
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""),
    `${responseRoute("requested-model", "low")}Answer${responseFooter("served-model", "low", "requested-model")}`);
});

test("footer examples inside an answer and incomplete responses retain their text", async () => {
  for (const status of ["completed", "incomplete"]) {
    const text = `Example:${responseFooter("example-model", "high", "requested-model")}\n\nThis line explains the example.`;
    const input = fixture("final_answer", false, status, text).stream;
    const output = await transform(input);
    const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    const expected = text;
    assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), expected);
    assert.equal(result.find((e) => e.type === "response.output_text.done").text, expected);
  }
  const text = `Answer${responseFooter("model", "high", "requested-model")}`;
  const output = await transform(fixture("final_answer", false, "incomplete", text).stream);
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), text);
});

test("an error before text.done releases held text without claiming a completed footer", async () => {
  const text = `Partial answer${responseFooter("unconfirmed-model", "high", "requested-model")}`;
  const { events } = fixture("final_answer", false, "completed", text);
  const partial = [...events.slice(0, 4), { type: "error", code: "synthetic_error", sequence_number: 4 }];
  const output = await transform(partial.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  const result = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
  assert.equal(result.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), text);
  assert.equal(result.at(-1).type, "error");
  assert.deepEqual(result.map((e) => e.sequence_number), result.map((_, index) => index));
});

test("JSON footer normalization and history cleanup preserve users, tools and non-trailer examples", async () => {
  const old = responseFooter("old-model", "high", "requested-model");
  const response = fixture("final_answer", false, "completed", `Answer${old}${old}`).events.at(-1)!.response;
  const output = JSON.parse(await transform(JSON.stringify(response), "application/json", 7, "requested-model"));
  assert.equal(output.output[0].content[0].text,
    `${responseRoute("requested-model", "low")}Answer${responseFooter("served-model", "low", "requested-model")}`);
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
