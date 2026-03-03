import { Tiktoken } from "js-tiktoken/lite";
import type { TiktokenBPE } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const TOKENS_PER_MESSAGE = 3.8;
const TOKENS_PER_CONVERSATION = 24;
const TOOL_PAYLOAD_JSON_OFFSET = 12;
const INTERRUPTED_TOOL_OUTPUT = "[Tool execution was interrupted]";
const TOKENIZER_ID = "js-tiktoken:o200k_base";

let sharedDefaultEncoder: Tiktoken | undefined;

type SessionMessage = {
  info?: {
    role?: string;
    error?: unknown;
  };
  parts?: Array<Record<string, unknown>>;
};

type SessionPart = Record<string, unknown> & {
  type?: string;
};

export type MessageCountDiagnostics = {
  tokens: number;
  countedMessages: number;
  skippedMessages: number;
  countedParts: number;
  skippedParts: number;
  tokenizer: string;
};

function getDefaultEncoder() {
  if (!sharedDefaultEncoder) {
    sharedDefaultEncoder = new Tiktoken(o200k_base);
  }
  return sharedDefaultEncoder;
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!value || typeof value !== "object") return false;
  return "info" in value || "parts" in value;
}

function stringifyPayload(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function countJsonPayloadOverhead(value: unknown) {
  return typeof value === "object" && value !== null
    ? -TOOL_PAYLOAD_JSON_OFFSET
    : 0;
}

export class TokenCounter {
  private encoder: Tiktoken;

  constructor(encoding?: TiktokenBPE) {
    this.encoder = encoding ? new Tiktoken(encoding) : getDefaultEncoder();
  }

  get tokenizer() {
    return TOKENIZER_ID;
  }

  countString(text: string) {
    if (!text) return 0;
    return this.encoder.encode(text, "all").length;
  }

  countMessage(message: unknown) {
    if (!isSessionMessage(message)) {
      return this.countString(stringifyPayload(message));
    }
    return this.inspectSessionMessage(message).tokens;
  }

  countMessages(messages: readonly unknown[]) {
    return this.inspectMessages(messages).tokens;
  }

  inspectMessages(messages: readonly unknown[]): MessageCountDiagnostics {
    if (!messages.length) {
      return {
        tokens: 0,
        countedMessages: 0,
        skippedMessages: 0,
        countedParts: 0,
        skippedParts: 0,
        tokenizer: this.tokenizer,
      };
    }

    let tokens = TOKENS_PER_CONVERSATION;
    let countedMessages = 0;
    let skippedMessages = 0;
    let countedParts = 0;
    let skippedParts = 0;

    for (const message of messages) {
      if (!isSessionMessage(message)) {
        tokens += this.countString(stringifyPayload(message));
        countedMessages += 1;
        continue;
      }

      const inspected = this.inspectSessionMessage(message);
      tokens += inspected.tokens;
      countedMessages += inspected.countedMessage ? 1 : 0;
      skippedMessages += inspected.countedMessage ? 0 : 1;
      countedParts += inspected.countedParts;
      skippedParts += inspected.skippedParts;
    }

    return {
      tokens: Math.round(tokens),
      countedMessages,
      skippedMessages,
      countedParts,
      skippedParts,
      tokenizer: this.tokenizer,
    };
  }

  private inspectSessionMessage(message: SessionMessage) {
    const role = message.info?.role ?? "unknown";
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let countedParts = 0;
    let skippedParts = 0;
    let content = role;
    let overhead = TOKENS_PER_MESSAGE;

    if (role === "user") {
      for (const part of parts) {
        const fragment = this.userFragment(part);
        if (!fragment) {
          skippedParts += 1;
          continue;
        }
        countedParts += 1;
        content += fragment.text;
        overhead += fragment.overhead;
      }
    } else if (role === "assistant") {
      const hasVisibleAssistantContent = parts.some((part) => {
        const type = String(part.type ?? "");
        return (
          type === "text" ||
          type === "reasoning" ||
          type === "tool" ||
          type === "step-start"
        );
      });
      if (message.info?.error && !hasVisibleAssistantContent) {
        return {
          tokens: 0,
          countedMessage: false,
          countedParts: 0,
          skippedParts: 0,
        };
      }

      for (const part of parts) {
        const fragment = this.assistantFragment(part);
        if (!fragment) {
          skippedParts += 1;
          continue;
        }
        countedParts += 1;
        content += fragment.text;
        overhead += fragment.overhead;
      }
    } else {
      if (!parts.length) {
        return {
          tokens: 0,
          countedMessage: false,
          countedParts: 0,
          skippedParts: 0,
        };
      }
      content += stringifyPayload(parts);
      countedParts = parts.length;
    }

    if (!countedParts) {
      return {
        tokens: 0,
        countedMessage: false,
        countedParts,
        skippedParts,
      };
    }

    return {
      tokens: Math.round(this.countString(content) + overhead),
      countedMessage: true,
      countedParts,
      skippedParts,
    };
  }

  private userFragment(part: SessionPart) {
    const type = String(part.type ?? "");
    switch (type) {
      case "text": {
        if (part.ignored) return undefined;
        return {
          text: String(part.text ?? ""),
          overhead: 0,
        };
      }
      case "compaction":
        return { text: "What did we do so far?", overhead: 0 };
      case "subtask":
        return {
          text: "The following tool was executed by the user",
          overhead: 0,
        };
      case "file": {
        const mime = String(part.mime ?? "");
        if (!mime || mime === "text/plain" || mime === "application/x-directory") {
          return undefined;
        }
        const filename =
          part.filename === undefined ? undefined : String(part.filename);
        const url = String(part.url ?? "");
        return {
          text: stringifyPayload({
            type: "file",
            mediaType: mime,
            filename,
            url,
          }),
          overhead: 0,
        };
      }
      default:
        return undefined;
    }
  }

  private assistantFragment(part: SessionPart) {
    const type = String(part.type ?? "");
    switch (type) {
      case "text":
        return {
          text: String(part.text ?? ""),
          overhead: 0,
        };
      case "reasoning":
        return {
          text: String(part.text ?? ""),
          overhead: 0,
        };
      case "step-start":
        return undefined;
      case "tool":
        return this.toolFragment(part);
      default:
        return undefined;
    }
  }

  private toolFragment(part: SessionPart) {
    const tool = String(part.tool ?? "");
    const callID = String(part.callID ?? "");
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = String(state.status ?? "");
    const input = stringifyPayload(state.input);
    let overhead = 0;
    let text = `tool:${tool}${callID ? `#${callID}` : ""}`;

    if (input) {
      text += ` input:${input}`;
      overhead += countJsonPayloadOverhead(state.input);
    }

    if (status === "completed") {
      const output = String(state.output ?? "");
      if (output) text += ` output:${output}`;
      const attachments = Array.isArray(state.attachments)
        ? state.attachments
        : [];
      if (attachments.length) {
        const labels = attachments
          .map((attachment) => {
            const item = attachment as Record<string, unknown>;
            const mime = String(item.mime ?? "");
            const filename = String(item.filename ?? "attachment");
            if (!mime) return "";
            return `[${mime}:${filename}]`;
          })
          .filter(Boolean)
          .join(" ");
        if (labels) text += ` attachments:${labels}`;
      }
      return { text, overhead };
    }

    if (status === "error") {
      text += ` error:${String(state.error ?? "")}`;
      return { text, overhead };
    }

    if (status === "pending" || status === "running") {
      text += ` error:${INTERRUPTED_TOOL_OUTPUT}`;
      return { text, overhead };
    }

    return undefined;
  }
}

export const tokenCounter = new TokenCounter();
