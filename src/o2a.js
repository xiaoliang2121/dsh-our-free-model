// src/o2a/version.js
var O2A_VERSION = "1.4.6";
var O2A_COMMIT = "58f56676ba1438adb30604b889bf36db2a1542a1";
var O2A_REFERENCE = "https://github.com/jasonxu114514/opencode2api";
var V2_CLIENT_VERSION = "2.2.5";
var CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`;
var V2_COMPLETION_LIMIT = 32e3;
var ANONYMOUS_CREDENTIAL = "public";

// src/o2a/identity.js
import crypto from "node:crypto";
var CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
var DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
var BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1e3;
var BOOT_NONCE = crypto.randomBytes(16);
function isOfficialSessionID(signal) {
  return typeof signal === "string" && CANONICAL_SESSION_RE.test(signal) && DESCENDING_TIME_RE.test(signal.slice(4, 16));
}
function canonicalSessionID(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal;
  const digest = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("ses\0"), BOOT_NONCE, Buffer.from([0]), Buffer.from(String(signal))])).digest();
  const timePart = descendingTimePart(now, digest);
  const randomPart = base62Fixed(digest.subarray(6, 16), 14);
  return `ses_${timePart}${randomPart}`;
}
var SESSION_PHASE_MS = 2n ** 36n;
function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null;
  const inverted = BigInt(`0x${id.slice(4, 16)}`);
  const current = ~inverted & 0xffffffffffffn;
  return Number(current >> 12n);
}
function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS);
}
function phaseAgeMs(phase, now = Date.now()) {
  const nowPhase = BigInt(now % Number(SESSION_PHASE_MS));
  const age = (nowPhase - BigInt(phase)) % SESSION_PHASE_MS;
  return Number((age + SESSION_PHASE_MS) % SESSION_PHASE_MS);
}
function descendingTimePart(now = Date.now(), hash) {
  const offset = ((hash[0] << 24 | hash[1] << 16 | hash[2] << 8 | hash[3]) >>> 0) % SESSION_TIMESTAMP_WINDOW_MS;
  const midnight = Math.floor(now / 864e5) * 864e5;
  const base = midnight - offset;
  const inverted = ~(BigInt(base) << 12n | 1n) & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, "0");
}
function base62Fixed(bytes, width) {
  let n = 0n;
  for (const byte of bytes) n = n << 8n | BigInt(byte);
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out.join("");
}
function randomID(prefix, size) {
  return `${prefix}_${crypto.randomBytes(size).toString("hex")}`;
}
function randomProjectID() {
  return crypto.randomBytes(20).toString("hex");
}

// src/o2a/tool-renames.js
import { createHash } from "node:crypto";
var CLIENT_TOOL_PREFIX = "mcp_";
var LEGACY_CLIENT_TOOL_PREFIXES = Object.freeze(["clint_"]);
var CLIENT_TOOL_DIGEST_LENGTH = 12;
var TOOL_WIRE_NAME_LIMIT = 64;
var DIGEST_HEX = "0123456789abcdef";
var COUNTER_SUFFIX = /^_\d+$/;
function isWireToolName(name) {
  if (typeof name !== "string" || name === "") return false;
  for (const namespace of [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES]) {
    if (!name.startsWith(namespace)) continue;
    const body = name.slice(namespace.length);
    const split = body.lastIndexOf("_");
    const digest = split > 0 && COUNTER_SUFFIX.test(body.slice(split)) ? body.slice(0, split) : body;
    if (digest.length !== CLIENT_TOOL_DIGEST_LENGTH) continue;
    let allHex = true;
    for (const char of digest) if (!DIGEST_HEX.includes(char)) {
      allHex = false;
      break;
    }
    if (allHex) return true;
  }
  return false;
}
function foldToolName(name) {
  return String(name ?? "").toLowerCase().replace(/[_.\- \t\r\n]/g, "");
}
function clientToolWireName(name, taken) {
  const issued = taken instanceof Set ? taken : /* @__PURE__ */ new Set();
  const digest = createHash("sha256").update(String(name)).digest("hex").slice(0, CLIENT_TOOL_DIGEST_LENGTH);
  const base = CLIENT_TOOL_PREFIX + digest;
  if (!issued.has(base)) {
    issued.add(base);
    return base;
  }
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`;
    const candidate = base.slice(0, TOOL_WIRE_NAME_LIMIT - suffix.length) + suffix;
    if (issued.has(candidate)) continue;
    issued.add(candidate);
    return candidate;
  }
}
var OFFICIAL_TOOL_ALIASES = Object.freeze({
  edit: ["edit"],
  glob: ["glob"],
  grep: ["grep"],
  question: ["question", "askuserquestion"],
  read: ["read", "view"],
  shell: ["shell", "bash"],
  skill: ["skill"],
  subagent: ["subagent", "agent", "task"],
  webfetch: ["webfetch", "fetch"],
  websearch: ["websearch"],
  write: ["write"],
  patch: ["patch", "applypatch"]
});
var OFFICIAL_BY_SPELLING = new Map(
  Object.entries(OFFICIAL_TOOL_ALIASES).flatMap(([canonical, spellings]) => spellings.map((spelling) => [foldToolName(spelling), canonical]))
);
function officialForClientName(name) {
  if (typeof name !== "string" || name === "") return null;
  return OFFICIAL_BY_SPELLING.get(foldToolName(name)) ?? null;
}
var ToolRenameMap = class extends Map {
  #byClient = /* @__PURE__ */ new Map();
  #byLower = /* @__PURE__ */ new Map();
  #byFolded = /* @__PURE__ */ new Map();
  /**
   * Record that `client`'s tool goes out as `wire`.
   *
   * No-ops when the mapping is trivial or already known, so shaping twice is
   * idempotent.
   */
  add(client, wire) {
    if (!client || !wire || client === wire) return;
    if (this.#byClient.has(client) || this.has(wire)) return;
    this.set(wire, client);
    this.#byClient.set(client, wire);
    for (const [index, key] of [[this.#byLower, String(client).toLowerCase()], [this.#byFolded, foldToolName(client)]]) {
      if (!key) continue;
      const existing = index.get(key);
      index.set(key, existing === void 0 || existing === client ? client : "");
    }
  }
  /** The handle issued for a caller tool, if any. */
  wireOf(client) {
    return this.#byClient.get(client);
  }
  /** Does any issued handle start with `prefix`? */
  hasPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) if (wire.startsWith(prefix)) return true;
    return false;
  }
  /** Does any issued handle extend `prefix` beyond itself? */
  hasLongerPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) if (wire.length > prefix.length && wire.startsWith(prefix)) return true;
    return false;
  }
  /**
   * Map a name arriving from the model back to the caller's tool name.
   *
   * Three attempts, in decreasing confidence:
   *
   * 1. An exact handle in this request's map.
   * 2. A handle minted by an earlier build: strip the namespace and look the
   *    remainder up as a caller name. This is what keeps a conversation saved
   *    under `clint_` working after an upgrade.
   * 3. Case-insensitive, then separator-insensitive lookup of whatever remains —
   *    including a name that was never renamed at all, which must survive intact
   *    so a genuine MCP tool is not mangled.
   *
   * Returns the input unchanged when nothing matches. That is the honest
   * outcome: the digest is one-way, so an unknown handle cannot be reversed, and
   * inventing a name would be worse than passing it through.
   */
  resolve(wire) {
    if (!wire) return wire;
    const exact = this.get(wire);
    if (exact !== void 0) return exact;
    if (!isWireToolName(wire)) {
      const drifted = this.#byLower.get(wire.toLowerCase());
      if (drifted !== void 0) return drifted || wire;
      return this.#byFolded.get(foldToolName(wire)) || wire;
    }
    const namespace = [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES].find((candidate) => wire.startsWith(candidate) && wire.length > candidate.length);
    const bare = namespace === void 0 ? wire : wire.slice(namespace.length);
    if (this.#byClient.has(bare)) return bare;
    const lower = this.#byLower.get(bare.toLowerCase());
    if (lower !== void 0 && lower !== "") return lower;
    return this.#byFolded.get(foldToolName(bare)) || wire;
  }
};

// src/o2a/asset-source.js
var OFFICIAL_PROMPT_V2 = `You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using opencode
- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues

When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the webfetch tool to gather information to answer the question from opencode docs at https://opencode.ai

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like shell or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Here are some examples to demonstrate appropriate verbosity:
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: what command should I run to watch files in the current directory?
assistant: [use the ls tool to list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
npm run dev
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with shell if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- When doing file search, prefer to use the subagent tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure.

# Code References

When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>

`;
var OFFICIAL_TOOLS_V2 = '{\n  "read": {\n    "description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "File or directory to read"\n        },\n        "offset": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "The line or directory entry to start reading from (1-based)"\n        },\n        "limit": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"\n        }\n      },\n      "required": [\n        "path"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "shell": {\n    "description": "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "command": {\n          "type": "string",\n          "description": "Shell command string to execute"\n        },\n        "workdir": {\n          "type": "string",\n          "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."\n        },\n        "timeout": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."\n        },\n        "background": {\n          "type": "boolean",\n          "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."\n        }\n      },\n      "required": [\n        "command"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "edit": {\n    "description": "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\\\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\\\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "File to edit"\n        },\n        "oldString": {\n          "type": "string",\n          "description": "Exact text to find and replace"\n        },\n        "newString": {\n          "type": "string",\n          "description": "Text to replace oldString with (must differ from oldString)"\n        },\n        "replaceAll": {\n          "type": "boolean",\n          "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."\n        }\n      },\n      "required": [\n        "path",\n        "oldString",\n        "newString"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "glob": {\n    "description": "Search file paths using a glob pattern (examples: \\"**/*.ts\\", \\"src/**/*.tsx\\").",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "pattern": {\n          "type": "string",\n          "description": "Glob pattern to match files against"\n        },\n        "path": {\n          "type": "string",\n          "description": "Directory to search. Defaults to the current working directory."\n        },\n        "hidden": {\n          "type": "boolean",\n          "description": "Include hidden files and directories (default: false)."\n        },\n        "limit": {\n          "type": "integer",\n          "exclusiveMinimum": 0,\n          "description": "Maximum number of matching files to return (default: 100)"\n        }\n      },\n      "required": [\n        "pattern"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "grep": {\n    "description": "Search file contents using ripgrep\'s regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "pattern": {\n          "type": "string",\n          "minLength": 1,\n          "description": "Regular expression or literal text to match in file contents."\n        },\n        "path": {\n          "type": "string",\n          "description": "File or directory to search. Defaults to the current working directory."\n        },\n        "include": {\n          "type": "string",\n          "description": "Glob pattern to filter files (for example, \\"*.js\\" or \\"*.{ts,tsx}\\")"\n        },\n        "literal": {\n          "type": "boolean",\n          "description": "Treat `pattern` as exact text instead of a regular expression (default: false)."\n        },\n        "caseSensitive": {\n          "type": "boolean",\n          "description": "Use case-sensitive matching (default: true)."\n        },\n        "limit": {\n          "type": "integer",\n          "exclusiveMinimum": 0,\n          "description": "Maximum number of matching lines to return (default: 100)"\n        }\n      },\n      "required": [\n        "pattern"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "write": {\n    "description": "Writes a file to the local filesystem, overwriting if one exists.\\n\\nMissing parent directories are created automatically.\\n\\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "Path to the file to write to"\n        },\n        "content": {\n          "type": "string",\n          "description": "Content to write to the file"\n        }\n      },\n      "required": [\n        "path",\n        "content"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "patch": {\n    "description": "Use the `patch` tool to edit files. Your patch language is a stripped\u2011down, file\u2011oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high\u2011level envelope:\\n\\n*** Begin Patch\\n[ one or more file sections ]\\n*** End Patch\\n\\nWithin that envelope, you get a sequence of file operations.\\nYou MUST include a header to specify the action you are taking.\\nEach operation starts with one of three headers:\\n\\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\\n*** Delete File: <path> - remove an existing file. Nothing follows.\\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\\n\\nExample patch:\\n\\n```\\n*** Begin Patch\\n*** Add File: hello.txt\\n+Hello world\\n*** Update File: src/app.py\\n*** Move to: src/main.py\\n@@ def greet():\\n-print(\\"Hi\\")\\n+print(\\"Hello, world!\\")\\n*** Delete File: obsolete.txt\\n*** End Patch\\n```\\n\\nIt is important to remember:\\n\\n- You must include a header with your intended action (Add/Delete/Update)\\n- You must prefix new lines with `+` even when creating a new file\\n",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "patchText": {\n          "type": "string",\n          "description": "The full patch text describing add, update, and delete operations"\n        }\n      },\n      "required": [\n        "patchText"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "webfetch": {\n    "description": "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\\n\\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "url": {\n          "type": "string",\n          "description": "The HTTP or HTTPS URL to fetch content from"\n        },\n        "format": {\n          "enum": [\n            "text",\n            "markdown",\n            "html"\n          ],\n          "description": "The format to return the content in. Defaults to markdown."\n        },\n        "timeout": {\n          "type": "number",\n          "exclusiveMinimum": 0,\n          "maximum": 120,\n          "description": "Optional timeout in seconds (maximum: 120)"\n        }\n      },\n      "required": [\n        "url",\n        "format"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "websearch": {\n    "description": "Search the web using the user\'s selected search integration. Use this for current information beyond knowledge cutoff.\\n\\nThe current year is 2026. Use this year when searching for recent information or current events.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "query": {\n          "type": "string",\n          "description": "Websearch query"\n        }\n      },\n      "required": [\n        "query"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "question": {\n    "description": "Use this tool when you need to ask the user questions during execution. This allows you to:\\n1. Gather user preferences or requirements\\n2. Clarify ambiguous instructions\\n3. Get decisions on implementation choices as you work\\n4. Offer choices to the user about what direction to take.\\n\\nUsage notes:\\n- A \\"Type your own answer\\" option is added automatically; don\'t include a separate option for free form answers\\n- Set `multiple: true` to allow selecting more than one option\\n- If you recommend a specific option, make that the first option in the list and add \\"(Recommended)\\" at the end of the label",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "questions": {\n          "type": "array",\n          "items": {\n            "type": "object",\n            "properties": {\n              "question": {\n                "type": "string"\n              },\n              "header": {\n                "type": "string"\n              },\n              "options": {\n                "type": "array",\n                "items": {\n                  "type": "object",\n                  "properties": {\n                    "label": {\n                      "type": "string"\n                    },\n                    "description": {\n                      "type": "string"\n                    }\n                  },\n                  "required": [\n                    "label",\n                    "description"\n                  ],\n                  "additionalProperties": false\n                }\n              },\n              "multiple": {\n                "type": "boolean"\n              }\n            },\n            "required": [\n              "question",\n              "header",\n              "options"\n            ],\n            "additionalProperties": false\n          },\n          "minItems": 1,\n          "description": "Questions to ask"\n        }\n      },\n      "required": [\n        "questions"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "skill": {\n    "description": "Load a specialized skill\'s instructions and resources into the current conversation when the task at hand matches its description.\\n\\nThe skill ID must match an available skill or a skill explicitly referenced by the user.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "id": {\n          "type": "string",\n          "description": "The ID of an available skill or a skill explicitly referenced by the user"\n        }\n      },\n      "required": [\n        "id"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "subagent": {\n    "description": "Spawns an agent in a child session to work on the specified task.\\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\\nNew child sessions start with fresh context, so include all relevant context and instructions when you don\'t pass a sessionID.\\nForeground (default) runs the subagent to completion and returns its final response.\\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\\nUse background only for independent work that can run while you continue elsewhere.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "agent": {\n          "type": "string",\n          "description": "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."\n        },\n        "description": {\n          "type": "string",\n          "description": "A short 3-5 word label for the task, displayed to the user"\n        },\n        "prompt": {\n          "type": "string",\n          "description": "The task for the subagent to perform"\n        },\n        "model": {\n          "type": "string",\n          "description": "NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as \\"providerID/modelID\\", or \\"providerID/modelID#variant\\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first."\n        },\n        "sessionID": {\n          "type": "string",\n          "description": "Send a follow-up to an existing subagent, running or finished. Omit to start a new one."\n        },\n        "background": {\n          "type": "boolean",\n          "description": "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."\n        }\n      },\n      "required": [\n        "agent",\n        "description",\n        "prompt"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "todowrite": {\n    "description": "Create and update a todo list for the current session. The user sees it as your working plan.\\n\\nUse it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.\\n\\n- Send the full list on every call; it replaces the previous one.\\n- Mark items `in_progress` when you start them and `completed` as soon as they\'re actually done.\\n- Only call it when the list changes.\\n",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "todos": {\n          "type": "array",\n          "items": {\n            "type": "object",\n            "properties": {\n              "content": {\n                "type": "string",\n                "description": "Brief description of the task"\n              },\n              "status": {\n                "enum": [\n                  "pending",\n                  "in_progress",\n                  "completed",\n                  "cancelled"\n                ],\n                "description": "Current status of the task: pending, in_progress, completed, cancelled"\n              }\n            },\n            "required": [\n              "content",\n              "status"\n            ],\n            "additionalProperties": false\n          },\n          "description": "The updated todo list"\n        }\n      },\n      "required": [\n        "todos"\n      ],\n      "additionalProperties": false\n    }\n  }\n}\n';
function officialPromptText() {
  return OFFICIAL_PROMPT_V2;
}
function officialToolsText() {
  return OFFICIAL_TOOLS_V2;
}

// src/o2a/official-tools.js
var V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  "edit",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "todowrite",
  "webfetch",
  "websearch",
  "write"
]);
var definitions;
function officialToolDefinition(name) {
  definitions ??= new Map(Object.entries(JSON.parse(officialToolsText())));
  return definitions.get(name);
}
function v2ShellDescription(base, platform = process.platform) {
  if (platform !== "win32") return base;
  return base.replace("on Linux using bash", "on Windows using powershell");
}
function officialTool(shape, name) {
  const definition = officialToolDefinition(name);
  let description = definition?.description ?? `Agent tool ${name}`;
  const parameters = definition?.parameters == null ? { type: "object", properties: {} } : structuredClone(definition.parameters);
  if (name === "shell") description = v2ShellDescription(description);
  if (shape === "claude") return { name, description, input_schema: parameters };
  const fn = { name, description, parameters };
  return shape === "flat" ? { type: "function", ...fn } : { type: "function", function: { ...fn, strict: false } };
}
function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map((name) => officialTool(shape, name));
}
function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (shape !== "chat") {
    const type = typeof entry.type === "string" ? entry.type : "";
    if (shape === "flat" && !["", "function", "custom"].includes(type)) return null;
    if (shape === "claude" && !["", "custom"].includes(type)) return null;
  }
  const name = shape === "chat" ? entry.function?.name : entry.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}
function isExactOfficialDefinition(entry, name, shape = "chat") {
  const wrapper = shape === "chat" ? entry?.function ?? entry : entry;
  if (!wrapper || typeof wrapper !== "object") return false;
  const rendered = officialTool(shape, name);
  const target = shape === "chat" ? rendered?.function ?? rendered : rendered;
  if (!target) return false;
  const schema = shape === "claude" ? wrapper.input_schema : wrapper.parameters;
  const targetSchema = shape === "claude" ? target.input_schema : target.parameters;
  return wrapper.description === target.description && JSON.stringify(schema) === JSON.stringify(targetSchema);
}

// src/o2a/official-prompt.js
var promptCache;
function officialPrompt() {
  if (promptCache !== void 0) return promptCache;
  promptCache = officialPromptText();
  return promptCache;
}
var OFFICIAL_PROMPT_MARKER = "You are opencode, an interactive CLI tool";
var OFFICIAL_SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var cachedWorkDir;
function workDir() {
  if (cachedWorkDir !== void 0) return cachedWorkDir;
  let directory = "";
  try {
    directory = process.cwd();
  } catch {
    directory = "";
  }
  directory = String(directory).trim();
  if (directory === "" || directory === ".") directory = "/workspace";
  cachedWorkDir = directory;
  return directory;
}
function officialEnvironment(model, directory = workDir()) {
  const apiModel = String(model ?? "").replace(/^opencode\//, "").trim() || "unknown";
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const now = /* @__PURE__ */ new Date();
  const date = `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, "0")} ${now.getUTCFullYear()}`;
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: yes",
    `  Platform: ${platform}`,
    `  Today's date: ${date}`,
    "</env>"
  ].join("\n");
}
function officialSystemPrompt(model, directory) {
  const base = officialPrompt();
  if (base === "") return "";
  return `${base}${officialEnvironment(model, directory)}
${OFFICIAL_SKILLS}`;
}
function textFragments(value) {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return textFragments(value.text);
    if (value.content !== void 0) return textFragments(value.content);
  }
  return [];
}
function carriesOpenCodePrompt(value) {
  return textFragments(value).some((part) => part.includes(OFFICIAL_PROMPT_MARKER));
}
function injectOfficialPrompt(payload, shape, { workDir: workDir2, model } = {}) {
  if (!payload || typeof payload !== "object") return false;
  if (shape !== "chat" && shape !== "flat" && shape !== "claude") return false;
  const prompt = officialSystemPrompt(model ?? payload.model, workDir2);
  if (prompt === "") return false;
  if (shape === "claude") return injectAnthropicPrompt(payload, prompt);
  if (shape === "flat") return injectResponsesPrompt(payload, prompt);
  return injectChatPrompt(payload, prompt);
}
function injectChatPrompt(payload, prompt) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let anchorIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "system" && role !== "developer") continue;
    if (carriesOpenCodePrompt(message.content)) return false;
    if (anchorIndex === -1) anchorIndex = i;
  }
  if (anchorIndex === -1) {
    payload.messages = [{ role: "system", content: prompt }, ...messages];
    return true;
  }
  const anchor = messages[anchorIndex];
  if (Array.isArray(anchor.content)) {
    messages[anchorIndex] = { ...anchor, content: [{ type: "text", text: prompt }, ...anchor.content] };
  } else if (typeof anchor.content === "string" && anchor.content.trim() !== "") {
    messages[anchorIndex] = { ...anchor, content: `${prompt}

${anchor.content}` };
  } else {
    messages[anchorIndex] = { ...anchor, content: prompt };
  }
  return true;
}
function injectAnthropicPrompt(payload, prompt) {
  const exists = payload.system !== void 0;
  if (exists && carriesOpenCodePrompt(payload.system)) return false;
  if (!exists) {
    payload.system = prompt;
    return true;
  }
  if (Array.isArray(payload.system)) {
    payload.system = [{ type: "text", text: prompt }, ...payload.system];
  } else if (typeof payload.system === "string" && payload.system.trim() !== "") {
    payload.system = `${prompt}

${payload.system}`;
  } else {
    payload.system = prompt;
  }
  return true;
}
function injectResponsesPrompt(payload, prompt) {
  const exists = payload.instructions !== void 0;
  if (exists && carriesOpenCodePrompt(payload.instructions)) return false;
  if (exists && typeof payload.instructions === "string" && payload.instructions.trim() !== "") {
    payload.instructions = `${prompt}

${payload.instructions}`;
    return true;
  }
  payload.instructions = prompt;
  return true;
}

// src/o2a/gateway-body.js
function ensureChatUsage(payload, shape) {
  if (shape !== "chat") return false;
  if (payload.stream !== true) return false;
  if (payload.stream_options && typeof payload.stream_options === "object" && !Array.isArray(payload.stream_options)) {
    if (payload.stream_options.include_usage === true) return false;
    payload.stream_options = { ...payload.stream_options, include_usage: true };
    return true;
  }
  payload.stream_options = { include_usage: true };
  return true;
}
function ensureV2CompletionLimit(payload, shape) {
  if (shape !== "chat") return false;
  if (payload.max_completion_tokens !== void 0) return false;
  if (payload.max_tokens !== void 0) return false;
  payload.max_completion_tokens = V2_COMPLETION_LIMIT;
  return true;
}

// src/o2a/headers.js
import crypto2 from "node:crypto";
var GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
function projectID(project) {
  if (project === "global" || GIT_COMMIT_RE.test(String(project))) return project;
  const sum = crypto2.createHash("sha256").update(`opencode-project\0${project}`).digest();
  return sum.subarray(0, 20).toString("hex");
}
function gatewayHeaders({ session, childSession, project, stream, accept, anthropic, userAgent, credential } = {}) {
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${credential ?? ANONYMOUS_CREDENTIAL}`,
    "user-agent": userAgent ?? CLIENT_UA,
    "x-opencode-client": "cli",
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-session": session,
    "x-opencode-session-id": childSession ?? session,
    "x-opencode-project": projectID(project ?? randomProjectID())
  };
  if (accept) headers["accept"] = accept;
  if (anthropic) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  return headers;
}

// src/o2a/toolshape.js
function renameAndCompleteTools(payload, shape, { keep } = {}) {
  if (shape !== "chat" && shape !== "flat" && shape !== "claude") {
    return { renames: new ToolRenameMap(), injected: [] };
  }
  const renames = new ToolRenameMap();
  const used = /* @__PURE__ */ new Set();
  const keepNames = keep instanceof Set ? keep : /* @__PURE__ */ new Set();
  let items = Array.isArray(payload.tools) ? [...payload.tools] : [];
  if ((shape === "chat" || shape === "flat") && Array.isArray(payload.functions)) {
    items = items.concat(convertLegacyFunctions(payload.functions, shape, renames, used));
    delete payload.functions;
  }
  const shaped = [];
  for (const item of items) {
    const name = renamableToolName(shape, item);
    if (name === null) {
      shaped.push(item);
      continue;
    }
    if (keepNames.has(name) || name.startsWith(CLIENT_TOOL_PREFIX)) {
      shaped.push(item);
      continue;
    }
    let wireName = renames.wireOf(name);
    if (wireName === void 0) {
      wireName = clientToolWireName(name, used);
      renames.add(name, wireName);
    }
    shaped.push(wireName !== name ? withToolName(shape, item, wireName) : item);
  }
  const injected = [];
  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (keepNames.has(name)) continue;
    shaped.push(officialTool(shape, name));
    injected.push(name);
  }
  payload.tools = shaped;
  rewriteToolReferences(payload, shape, renames);
  return { renames, injected };
}
function withToolName(shape, entry, name) {
  if (shape === "chat") {
    return { ...entry, function: { ...entry.function, name } };
  }
  return { ...entry, name };
}
function convertLegacyFunctions(entries, shape, renames, used) {
  const converted = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (name === "") continue;
    let wireName = renames.wireOf(name);
    if (wireName === void 0) {
      wireName = clientToolWireName(name, used);
      renames.add(name, wireName);
    }
    const description = typeof raw.description === "string" ? raw.description : void 0;
    const parameters = raw.parameters ?? { type: "object", properties: {} };
    if (shape === "chat") {
      const fn = { name: wireName, description, parameters };
      if (raw.strict !== void 0) fn.strict = raw.strict;
      converted.push({ type: "function", function: fn });
    } else {
      const tool = { type: "function", name: wireName, description, parameters };
      if (raw.strict !== void 0) tool.strict = raw.strict;
      converted.push(tool);
    }
  }
  return converted;
}
function rewriteToolReferences(payload, shape, renames) {
  if (renames.size === 0) return;
  const renamed = (container) => {
    if (!container || typeof container !== "object") return null;
    const name = container.name;
    if (typeof name !== "string") return null;
    const wireName = renames.wireOf(name);
    return wireName !== void 0 && wireName !== name ? wireName : null;
  };
  if (shape === "chat") {
    const choice2 = objectOf(payload.tool_choice);
    if (choice2) {
      if (choice2.function && typeof choice2.function === "object") {
        const wire = renamed(choice2.function);
        if (wire !== null) payload.tool_choice = { ...choice2, function: { ...choice2.function, name: wire } };
      } else {
        const wire = renamed(choice2);
        if (wire !== null) payload.tool_choice = { ...choice2, name: wire };
      }
    }
    const call = objectOf(payload.function_call);
    if (call) {
      const wire = renamed(call);
      if (wire !== null) payload.function_call = { ...call, name: wire };
    }
    const messages2 = Array.isArray(payload.messages) ? payload.messages : [];
    for (let i = 0; i < messages2.length; i += 1) {
      const message = messages2[i];
      if (!message || typeof message !== "object") continue;
      let next = null;
      const fnCall = objectOf(message.function_call);
      if (fnCall) {
        const wire = renamed(fnCall);
        if (wire !== null) next = { ...message, function_call: { ...fnCall, name: wire } };
      }
      if (Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map((entry) => {
          const fn = objectOf(entry?.function);
          if (!fn) return entry;
          const wire = renamed(fn);
          return wire !== null ? { ...entry, function: { ...fn, name: wire } } : entry;
        });
        if (calls.some((entry, j) => entry !== message.tool_calls[j])) {
          next = { ...next ?? message, tool_calls: calls };
        }
      }
      if (next !== null) messages2[i] = next;
    }
    return;
  }
  if (shape === "flat") {
    const choice2 = objectOf(payload.tool_choice);
    if (choice2) {
      let next = null;
      const wire = renamed(choice2);
      if (wire !== null) next = { ...choice2, name: wire };
      if (Array.isArray(choice2.allowed_tools)) {
        const allowed = choice2.allowed_tools.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const entryWire = renamed(entry);
          return entryWire !== null ? { ...entry, name: entryWire } : entry;
        });
        if (allowed.some((entry, j) => entry !== choice2.allowed_tools[j])) {
          next = { ...next ?? choice2, allowed_tools: allowed };
        }
      }
      if (next !== null) payload.tool_choice = next;
    }
    const input = Array.isArray(payload.input) ? payload.input : [];
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i];
      const type = typeof item?.type === "string" ? item.type : "";
      if (type !== "function_call" && type !== "custom_tool_call") continue;
      const wire = renamed(item);
      if (wire !== null) input[i] = { ...item, name: wire };
    }
    return;
  }
  const choice = objectOf(payload.tool_choice);
  if (choice) {
    const wire = renamed(choice);
    if (wire !== null) payload.tool_choice = { ...choice, name: wire };
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) continue;
    const content = message.content.map((block) => {
      if (block?.type !== "tool_use") return block;
      const wire = renamed(block);
      return wire !== null ? { ...block, name: wire } : block;
    });
    if (content.some((block, j) => block !== message.content[j])) {
      messages[i] = { ...message, content };
    }
  }
}
function objectOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export {
  ANONYMOUS_CREDENTIAL,
  BASE62_ALPHABET,
  CANONICAL_SESSION_RE,
  CLIENT_TOOL_DIGEST_LENGTH,
  CLIENT_TOOL_PREFIX,
  CLIENT_UA,
  DESCENDING_TIME_RE,
  LEGACY_CLIENT_TOOL_PREFIXES,
  O2A_COMMIT,
  O2A_REFERENCE,
  O2A_VERSION,
  OFFICIAL_PROMPT_MARKER,
  OFFICIAL_SKILLS,
  OFFICIAL_TOOL_ALIASES,
  SESSION_PHASE_MS,
  SESSION_TIMESTAMP_WINDOW_MS,
  TOOL_WIRE_NAME_LIMIT,
  ToolRenameMap,
  V2_CLIENT_VERSION,
  V2_COMPLETION_LIMIT,
  V2_OFFICIAL_TOOL_ORDER,
  base62Fixed,
  canonicalSessionID,
  carriesOpenCodePrompt,
  clientToolWireName,
  currentTimePhaseMs,
  descendingTimePart,
  ensureChatUsage,
  ensureV2CompletionLimit,
  foldToolName,
  gatewayHeaders,
  injectOfficialPrompt,
  isExactOfficialDefinition,
  isOfficialSessionID,
  isWireToolName,
  officialEnvironment,
  officialForClientName,
  officialPrompt,
  officialSystemPrompt,
  officialTool,
  officialToolDefinition,
  officialToolset,
  phaseAgeMs,
  projectID,
  randomID,
  randomProjectID,
  renamableToolName,
  renameAndCompleteTools,
  sessionPhaseMs,
  textFragments,
  v2ShellDescription
};
