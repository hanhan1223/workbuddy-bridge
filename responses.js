/**
 * OpenAI Responses API (/v1/responses) translation layer.
 *
 * Codex speaks the Responses protocol, not Chat Completions, so a bridge that
 * only implements /v1/messages and /v1/chat/completions cannot serve it. This
 * module converts in both directions:
 *
 *   request  : Responses `input` items  ->  upstream chat messages
 *   response : upstream chat completion ->  Responses events or the final object
 *
 * The shapes implemented here follow the documented Responses lifecycle:
 *
 *   response.created -> response.in_progress
 *   -> response.output_item.added (message) -> response.content_part.added
 *   -> response.output_text.delta* -> response.output_text.done
 *   -> response.content_part.done -> response.output_item.done
 *   -> response.completed
 *
 * Function calls use a parallel shape:
 *
 *   response.output_item.added (function_call)
 *   -> response.function_call_arguments.delta* -> ...done
 *   -> response.output_item.done
 */

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

/** Flatten Responses content (string or array of parts) into plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part === null || typeof part !== 'object') return '';
      // input_text / output_text / text are all spelled this way.
      if (typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert a Responses request body into the upstream chat shape.
 *
 * `instructions` is the Responses spelling of the system prompt. `input` is
 * either a plain string or an item array that may contain messages, prior
 * function calls, and function call outputs.
 */
function responsesToChat(body, defaultModel) {
  const messages = [];

  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? body.instructions
      : DEFAULT_SYSTEM_PROMPT;
  messages.push({ role: 'system', content: instructions });

  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || typeof item !== 'object') continue;

      // A function call the model previously made: replay it so the model can
      // see its own tool history (omitting it causes repeated re-calling).
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: typeof item.content === 'string' ? item.content : '',
          tool_calls: [
            {
              id: typeof item.call_id === 'string' ? item.call_id : 'call_0',
              type: 'function',
              function: {
                name: typeof item.name === 'string' ? item.name : '',
                arguments:
                  typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
        continue;
      }

      // The result of that call. `role: 'tool'` is required, and the call_id
      // must match the call above or the upstream rejects the history.
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof item.call_id === 'string' ? item.call_id : '',
          content: contentToText(item.output),
        });
        continue;
      }

      // Ordinary message item.
      if (item.type === 'message' || item.role !== undefined) {
        const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
        const text = contentToText(item.content);
        if (text !== '') messages.push({ role, content: text });
      }
    }
  }

  const out = {
    model: typeof body.model === 'string' && body.model !== '' ? body.model : defaultModel,
    messages,
    max_tokens:
      typeof body.max_output_tokens === 'number'
        ? body.max_output_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
  };

  // Responses tools -> OpenAI function tools.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((t) => t !== null && typeof t === 'object' && t.type === 'function' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : undefined,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
  }

  const tc = body.tool_choice;
  if (typeof tc === 'string') out.tool_choice = tc;
  else if (tc !== null && typeof tc === 'object' && typeof tc.type === 'string') {
    if (tc.type === 'auto' || tc.type === 'required') out.tool_choice = tc.type;
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'function' && typeof tc.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  return out;
}

/** Build the final (non-streamed) Response object. */
function buildResponseObject({ id, model, text, toolCalls, createdAt }) {
  const output = [];

  if (text !== '') {
    output.push({
      id: `msg_${id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const call of toolCalls ?? []) {
    output.push({
      id: `fc_${call.id}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  const hasCalls = (toolCalls ?? []).length > 0;

  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    // Downstream agents key off this to decide whether to run tools.
    incomplete_details: null,
    ...(hasCalls ? {} : {}),
  };
}

/**
 * Emit the full streaming event sequence for one completion.
 *
 * `write` receives (eventName, dataObject). Deltas are emitted as they arrive
 * so the client can render incrementally, matching the documented lifecycle.
 */
function createResponsesStream({ id, model, createdAt, write }) {
  let seq = 0;

  const envelope = (status) => ({
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: null,
    incomplete_details: null,
  });

  const emit = (type, data) => write(type, { type, sequence_number: seq++, ...data });

  const responseCreated = () => {
    emit('response.created', { response: envelope('in_progress') });
    emit('response.in_progress', { response: envelope('in_progress') });
  };

  const textItemId = `msg_${id}`;
  let textItemOpen = false;
  let textBuffer = '';

  const openTextItem = () => {
    if (textItemOpen) return;
    textItemOpen = true;
    emit('response.output_item.added', {
      output_index: 0,
      item: { id: textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    emit('response.content_part.added', {
      item_id: textItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const onTextDelta = (delta) => {
    openTextItem();
    textBuffer += delta;
    emit('response.output_text.delta', {
      item_id: textItemId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    });
  };

  const closeTextItem = () => {
    if (!textItemOpen) return;
    emit('response.output_text.done', {
      item_id: textItemId,
      output_index: 0,
      content_index: 0,
      text: textBuffer,
      logprobs: [],
    });
    emit('response.content_part.done', {
      item_id: textItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: textBuffer, annotations: [] },
    });
    emit('response.output_item.done', {
      output_index: 0,
      item: {
        id: textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: textBuffer, annotations: [] }],
      },
    });
  };

  const finish = (toolCalls) => {
    closeTextItem();

    const output = [];
    if (textItemOpen) {
      output.push({
        id: textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: textBuffer, annotations: [] }],
      });
    }

    let outputIndex = output.length;
    for (const call of toolCalls ?? []) {
      const itemId = `fc_${call.id}`;
      const args = call.function.arguments === '' ? '{}' : call.function.arguments;

      emit('response.output_item.added', {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: call.id,
          name: call.function.name,
          arguments: '',
        },
      });
      emit('response.function_call_arguments.delta', {
        item_id: itemId,
        output_index: outputIndex,
        delta: args,
      });
      emit('response.function_call_arguments.done', {
        item_id: itemId,
        output_index: outputIndex,
        name: call.function.name,
        arguments: args,
      });
      emit('response.output_item.done', {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'completed',
          call_id: call.id,
          name: call.function.name,
          arguments: args,
        },
      });

      output.push({
        id: itemId,
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: call.function.name,
        arguments: args,
      });
      outputIndex++;
    }

    const final = {
      ...envelope('completed'),
      output,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    emit('response.completed', { response: final });
  };

  const fail = (message) => {
    emit('response.failed', {
      response: { ...envelope('failed'), error: { code: 'server_error', message } },
    });
  };

  return { responseCreated, onTextDelta, finish, fail };
}

export { responsesToChat, buildResponseObject, createResponsesStream };
